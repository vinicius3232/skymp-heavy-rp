# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento [SemVer](https://semver.org/lang/pt-BR/).

> **Sobre o `0.x`:** o projeto fica em versão zero enquanto **nada tiver sido validado numa sessão de jogo real**. Publicar `1.0.0` sem isso seria prometer estabilidade que não foi verificada. A `1.0.0` sai depois do teste in-game da Fase 1 — ver [QA_REPORT_2026-08.md](docs/technical/QA_REPORT_2026-08.md) §3.

---

## [Não lançado]

### Adicionado

- **`/revelaridentidade` — a revelação de identidade por staff, que o desenho pedia desde 12/07/2026.** O [`NAMETAG_IDENTITY_SYSTEM.md`](docs/technical/NAMETAG_IDENTITY_SYSTEM.md) listava *"Staff futura: nome real, com permissao auditada"* como regra 2 de 4 da escada de exibição, e a única implementação que existiu vivia no `disguise-service`, apagado em 06/08 — respondendo com o nome de **quem digitou o comando** em vez do alvo.

  **Comando explícito, não estado passivo.** "Staff sempre vê o nome real" não tem evento para auditar, e a regra pede auditoria: um estado não responde *quem* furou o anonimato de *quem* e *quando*, que é a pergunta de uma arbitragem contestada. Além disso obrigaria o `identity-service` a importar o `admin-service` para consultar o `staffCache` (chaveado por `actorId`, enquanto `getDisplayName` trabalha com personagens), e o efeito apareceria de uma vez em todo chamador — chat local, aba Social, nametag. É a forma de defeito que a [`PARKED_SERVICES_DECISION.md`](docs/technical/PARKED_SERVICES_DECISION.md) §7.1 usou para apagar o `disguise-service`, por dentro em vez de por fora. O preço da escolha é atrito: investigar custa um comando por pessoa. Aceito.

  **Permissão `reveal_identity` nova, `admin` e `owner`.** O candidato fácil era `view_audit`, e é errado pela mesma razão que `add_item` era errado para receita (§7.4): significa ler o que a **staff** fez, não furar o anonimato de um **jogador** — quem auditasse *"quem pode `view_audit`?"* teria a resposta errada. E é permissão de moderador, então reaproveitá-la alargaria o poder para a linha de frente inteira sem decisão. Fora do moderador porque **revelar é a única ação de staff que não desfaz**: kick acaba na reconexão, ouro volta por outro `/setgold`, `/permakill` é soft-delete. Identidade revelada mora na cabeça de quem leu.

  **Não escreve em `character_known_identities`.** Aquilo é conhecimento IC; gravá-lo faria o personagem da staff chamar o alvo pelo nome real no chat para sempre — investigação virando metagaming com rastro de aparência legítima.

  10 testes de comportamento mais a entrada na matriz de cargo × ação. Seis mutações aplicadas e executadas, não previstas: remover a checagem de permissão reprova 4; revelar sem auditar reprova 5; trocar o alvo pelo executor reprova 2; inverter ator/alvo na auditoria reprova 1; dar `reveal_identity` ao moderador reprova 2; gravar em `character_known_identities` reprova 1.

- **`nametag-service.js` — prova de conceito da etiqueta acima da cabeça.** A pergunta que travava a nametag desde a origem era se o servidor consegue saber onde um ator aparece na tela do observador. A resposta é **sim, mas não o servidor**, e essa distinção é a peça inteira.

  **[DOC]** `worldPointToScreenPoint` — *"convert an array of points in the game world to an array of points on the user's screen. The dot on the screen is indicated by 3 numbers from -1 to 1"* (`skymp/docs/skyrim_platform/new_methods.md`; assinatura das tipagens oficiais). **[DOC]** evento `update` — *"Called once for every frame in the game (60 times per second at 60 FPS)"*. As duas assinaturas foram registradas em `types/mp.d.ts` com a procedência.

  **Isso roda no motor JS do cliente, não é `mp.callPapyrusFunction`.** O bloqueio registrado — nametag por Papyrus por quadro inviabilizaria o servidor — vinha das medições que o Red House deixou anotadas (13 ms num `getEquipment`, 35 ms num `av.set`), que são de chamadas do **servidor** para o Papyrus do cliente, ida e volta pela rede. O painel do jogador paga esse preço porque lê vitais de lá. A projeção não paga: é função nativa do próprio processo do jogo. O argumento que bloqueava não se aplica a este caminho.

  **Duas frequências, porque são duas grandezas.** Nome e alvo: 2 s, o mesmo tick da voz — nome só muda quando alguém se apresenta, e a defasagem é a mesma que o `proximity_update` já carrega. Posição na tela: até 20 Hz no cliente, porque a cada 2 s a etiqueta não parece atrasada, parece quebrada. Não é por quadro porque o custo não é a projeção, é o `executeJavaScript` atravessando para a CEF — custo **não medido**, então o padrão é conservador, igual ao HUD de voz.

  **Uma etiqueta, a do mais próximo.** Dez provariam o mesmo e multiplicariam por dez um custo de CEF que ninguém mediu. **Não toca `getDisplayName()`** — é requisito, não conveniência: quando o disfarce virar degrau daquela função (§7.1), a etiqueta passa a mostrar o nome disfarçado sem uma linha de mudança.

  ⚠️ **A projeção nunca foi executada, e isso tem o mesmo peso que "ninguém ouviu ainda" tem na voz nativa.** `ctx.sp.worldPointToScreenPoint` nunca foi chamada — que seja alcançável por esse caminho é **inferência**, não observação; a convenção dos eixos não foi verificada; ponto atrás da câmera é buraco conhecido; o custo a 20 Hz não foi medido; **ninguém validou com dois clientes**, que é o requisito de alfa que aquele documento carrega desde a origem. Desligado por padrão (`ENABLE_NAMETAG_SERVICE`).

  24 testes. Os seis últimos leem o snippet de cliente **como texto** e reprovam padrão proibido — é a única forma de proteger uma decisão sobre código que roda numa máquina que o processo de teste nunca vê; um `callPapyrusFunction` no laço de tela reprova.

- **`soul-service.js` — a Afinidade da Alma passa a falar com o mundo.** `core/soul.js` (domínio puro, 28 testes) estava fechado desde antes; o que faltava era a camada que persiste a alma, entrega sinais, grava marcas, avança a árvore e audita rolagem. O desenho de [`SOUL_AFFINITY.md`](docs/design/SOUL_AFFINITY.md) foi **implementado, não rediscutido**.

  Junto vieram as quatro tabelas que aquele documento especifica (migration v10): `character_soul`, `character_signs`, `character_marks`, `character_paths`. Registrado no `module-registry` atrás de `ENABLE_SOUL_SERVICE`, fase `lab`, **desligado por padrão**.

  **A alma é congelada no primeiro spawn e nunca rederivada.** A staff pode editar a ficha pelo painel; rederivar trocaria a alma de quem já jogou meses com ela, em silêncio, e deixaria órfãs as marcas — que *são* a progressão (§II.3). Há teste de mutação para isso.

  **A semente não entra em `audit_logs`** — só uma impressão digital de 8 caracteres. A §14.3 exige que a staff reproduza uma rolagem contestada e a §III.3 exige que o segredo nunca saia do servidor; as duas valem ao mesmo tempo. `GET /api/audit` devolve `details` inteiro para qualquer staff no navegador, e com a semente ali, mais este repositório que é público, qualquer pessoa reproduziria **todas** as rolagens futuras daquele personagem — não só a contestada. A reprodução continua possível por `character_soul`, que exige o banco.

  **Sem `SOUL_SECRET` o módulo falha no boot, de propósito.** Alma derivada de segredo vazio é recalculável a partir da ficha, que é pública no painel, e o estrago seria permanente porque a alma é congelada. Mesma lição do `.env` que ninguém carregava: o modo de falha aponta para o lado seguro.

  31 testes, cobrindo os três itens do §III.12 que o domínio não prova sozinho — consentimento em nó irreversível, a semente que não vaza, e o firewall de identidade nas marcas visíveis. Verificados por mutação: remover a checagem de consentimento reprova 2, vazar os valores no painel reprova 1, trocar `identity.getDisplayName` por leitura direta de nome reprova 2, rederivar a alma reprova 1.

  Mais dois checks operacionais no `test:systems`. Um deles varre os quatro apps atrás de `soul_seed`/`SOUL_SECRET`/`character_soul`: a semente vive no gamemode e o painel é outro processo com acesso ao mesmo banco, então um endpoint que a exponha não reprovaria em nenhum teste unitário. Verificado plantando uma sonda que faz exatamente isso.

  ⚠️ **Confirmado por teste automatizado, não confirmado em sessão real** — igual a `hit-events`/`espm`/`safe-zones`. A [Etapa 9.4 do roteiro](docs/technical/FASE_0_ROTEIRO.md) foi escrita e **não executada**. Ela também registra o que 9.4 *não* testa: marcas e árvore existem e têm teste, mas nenhum caminho de jogo chega até elas — a etapa 2 do desenho põe os quatro resultados em encantamento, e encantamento depende do `crafting-service`, que continua PARKED.

- **Log de moderação no Discord** (`apps/bot-discord/moderationLog.js`). A [`ARCHITECTURE.md` 1.3](docs/ARCHITECTURE.md) registrava isto como a intenção original do bot e anotava que **nunca foi implementado**; até aqui ele só expunha o sync de cargo e os comandos de voz.

  Cobre `kick` e `permakill` (do gamemode) e as três decisões de whitelist (do painel). **`ban` fica declarado e sem produtor**, de propósito: `ban` é uma permissão que os cargos `admin` e `owner` concedem e que **nenhum comando consome** — não existe `/ban` no gamemode nem no painel. O tipo declarado (com teste travando o formato) faz o dia em que o comando existir custar uma linha; inventar o produtor agora seria implementar uma ação que o servidor não tem.

  **O canal não é o registro — é notificação.** O registro continua sendo `audit_logs`, escrito no mesmo fluxo da ação, antes de qualquer coisa sair para o Discord. Isso decide o comportamento em falha: com o Discord fora, a moderação acontece do mesmo jeito, nada é desfeito e nada fica lento. O endpoint responde 202 **antes** de falar com o Discord, e nenhum produtor faz `await` do envio — um `/permakill` não pode esperar por API de terceiro.

  **Push, não polling de `audit_logs`.** O bot tem `mysql2` em `dependencies` sem usar, então ler a tabela era possível; descartado porque daria credencial de banco a um terceiro processo para ler o que ele não escreve, em troca de latência. O cliente do gamemode usa `http.request` do core e não `fetch`: a versão do Node embutida no SkyMP não é controlada por nós e `fetch` global só existe do 18 em diante.

  21 testes com `discord.js` mockado. Cobrem o que a fronteira de confiança exige: `kind` desconhecido não vira embed vazio no canal da staff, `@everyone` num motivo não vira ping (quem escreve o motivo é staff digitando em jogo, e o texto atravessa três processos), e falha do Discord nunca lança — sem o `try/catch` a rejeição subiria como *unhandled* no `.then()` do endpoint e derrubaria o bot inteiro porque o Discord ficou lento num kick.

  Um dos testes varre o próprio fonte atrás de caractere invisível. O separador de menção é um zero-width space e a classe de controle está numa regex; escritos crus, deixaram os dois arquivos binários para o `grep` e para o `file` — exatamente o defeito que o `core/soul.js` já custou a achar, onde quem lesse a linha entenderia o oposto do que ela faz.

- **Assinatura do instalador do launcher, configurada e verificável** (QA 3.3). O item dizia que "as chaves já são lidas do ambiente pelo `electron-builder`" — verdade sobre o `electron-builder`, não sobre este repositório: não havia nada configurado. `win.signtoolOptions` entrou com o que **não** é segredo (dois servidores de carimbo de tempo e `sha256` apenas); `CSC_LINK` e `CSC_KEY_PASSWORD` continuam vindo do ambiente e não aparecem em lugar nenhum do repositório.

  **O carimbo de tempo não é detalhe:** sem ele, todo instalador já distribuído vira "assinatura inválida" no dia em que o certificado vencer, inclusive os que os jogadores baixaram meses antes.

  Workflow próprio (`release-launcher.yml`) em `windows-latest`, separado do CI que roda em Ubuntu a cada push. Ele avisa antes se o build vai sair assinado, constrói, e **verifica de verdade**: `Get-AuthenticodeSignature` precisa devolver `Valid` **e** um carimbo. Havendo certificado e a assinatura não colando, o job falha — instalador não assinado saindo de um build que deveria assinar é pior que build quebrado, porque parece que deu certo. Sem `CSC_LINK`, o build continua funcionando e gera o instalador não assinado, para que contribuidor e build local não dependam de um certificado que só quem opera o servidor tem.

  Não foi usado o formato de comentário `"//chave"` no `electron-builder.json`: ao contrário do `package.json`, o schema dele declara `additionalProperties: false` e o build falharia na validação. Conferido contra o `scheme.json` da versão instalada (26.15.3), chave por chave; a explicação foi toda para [`LAUNCHER_DISTRIBUTION.md` §6](docs/technical/LAUNCHER_DISTRIBUTION.md).

  ⚠️ **Continua aberto, e não é código:** comprar o certificado (a §6.3 compara OV, EV e Azure Trusted Signing com custo e comportamento do SmartScreen) e confirmar o SmartScreen à mão — reputação é construída pela Microsoft ao longo de downloads reais, e a única verificação possível é baixar pelo navegador numa máquina Windows limpa.


- **Agressão relatada pelo cliente vira evidência de combate** (`core/hit-events.js`). Quarto e último item do aproveitamento do Red House: `mp.makeEventSource` injeta um trecho no cliente que escuta o evento `hit` do Skyrim Platform e reporta quem bateu em quem.

  Substitui o `checkDamageSpike` do `death-service`, que chamava de agressão qualquer queda de 25 pontos de vida num tick de 2 s — não distinguia combate de queda de penhasco, não sabia quem bateu, e só existia porque estava pendurado no polling.

  **É evidência, não enforcement, e a diferença é deliberada.** O Red House recalcula o dano a partir deste evento e aplica; nós não. Quem manda o evento é a máquina do jogador, e o [CONTRIBUTING](CONTRIBUTING.md) §3.6 é explícito: evento de cliente é *"uma dica, não uma prova"*. Usar isso para decidir dano entregaria o combate a quem controla o cliente. A linha gravada diz de onde veio, para que ninguém a trate como prova numa arbitragem.

  **Agrega em episódio.** Uma briga gera dezenas de eventos; gravar linha por golpe inutilizaria o `audit_logs` justamente quando a staff mais precisa dele. Uma linha dizendo "A bateu em B sete vezes, duas com power attack, ao longo de doze segundos" responde melhor do que sete linhas iguais.

  `mp.makeEventSource` foi confirmada num servidor real e o boot registra o evento. **O snippet de cliente ainda não rodou** — ele só executa quando alguém conecta, o que é a Fase 0.

- **Validação de item contra os plugins carregados** (`core/espm.js`). Terceiro item do aproveitamento do Red House: `mp.lookupEspmRecordById` deixa o servidor ler os records dos ESMs, então dá pra conferir se um `base_id` existe e é mesmo um item — em vez de gravar qualquer número no inventário.

  Ligado nos dois pontos onde um `base_id` **novo entra** no sistema: `/additem` e o anúncio em barraca. Nos dois o valor vem digitado à mão em hexadecimal, e antes disto um dígito errado gravava `character_inventory` do mesmo jeito — o item nunca aparecia in-game, mas ocupava linha no banco e no ledger, e ninguém descobria até alguém conferir inventário à mão. Na barraca é pior: alguém paga por uma linha que nunca vira item na tela.

  **O formato da API foi confirmado num servidor real, não inferido.** O projeto sabia que a função existia e nunca tinha visto o retorno dela; uma sonda temporária foi apontada como gamemode e o log respondeu. O detalhe que uma implementação adivinhada erraria: FormID inválido devolve `{}` — objeto vazio e **truthy** —, então `if (r)` faria o Player passar como item. A checagem certa é `r && r.record`, e há teste de mutação para isso. A assinatura entrou em `types/mp.d.ts` marcada como `[USO]`, com a procedência.

  A validação **deixa passar quando não dá pra saber**: existe para pegar erro de digitação, não para ser autoridade. Só nega quando a API respondeu e respondeu que aquele FormID não é item — senão viraria uma quebra de `/additem` em qualquer servidor onde ela não exista.

- **Zonas seguras — a `action-policy` passa a bloquear por lugar, não só por estado.** Vem do Red House, que checa `isInSafeLocation` antes de aplicar dano ([REFERENCE_STUDY §4.1](docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md)). `core/safe-zones.js` responde onde alguém está e o que aquele lugar proíbe; a `canPerform` ganhou a dimensão usando o `context` que já estava declarado como "para validações futuras".

  A **regra dos dois lados** veio junto e tem teste próprio: uma ação entre duas pessoas é barrada se qualquer uma estiver protegida, porque proteger só o alvo deixaria alguém atirar de dentro da zona para fora dela. Estado continua sendo checado antes de lugar — para quem está algemado dentro de uma zona segura, "você está algemado" é a explicação útil.

  **A lista de zonas nasce vazia.** Zona segura é mecânica de mundo, e a Constituição §15 pede as 15 perguntas antes; as quatro que mais mudam o desenho estão em `skymp/config/safe-zones.example.json`. O mecanismo está entregue, a política não — mesmo padrão do `npc-cleaner`. Nenhum chamador atual mudou de comportamento, e isso tem teste.

- **`--only-load-order` no gerador de manifesto**, para rodar a Fase 0 antes do modpack existir. Sem ele, gerar o `mods.json` de uma `Data/` de trabalho produz um manifesto que exige a máquina de quem gerou — o `compareMods` do launcher reprova todo arquivo que o cliente não tenha, então um testador com instalação limpa é barrado por um mod que não faz parte de nada. O gerador não tinha teste nenhum, sendo o que decide o contrato de FormID; ganhou 6.

### Conformidade de licença

- **Atribuição de origem completa nos três sistemas vindos do Red House.** A [política §4](docs/technical/LICENSE_AND_AFFILIATION_POLICY.md) exige registrar **projeto, autor, licença e commit** no cabeçalho do arquivo *e* aqui. Os três traziam só uma referência ao estudo — o que diz de onde veio a ideia, não sob que termos ela veio. Corrigido em `core/hit-events.js`, `core/espm.js` e `core/safe-zones.js`.

  | | |
  |---|---|
  | Projeto | [`alekcey0211/red-house-public`](https://github.com/alekcey0211/red-house-public) — build pública do Red House (SkyMP) |
  | Autor | alekcey0211 e colaboradores |
  | Licença | **GPL-3.0** — compatível com a AGPL-3.0-or-later deste projeto pela GPLv3 §13; o conjunto continua sob AGPL |
  | Commit | `65c66bb3e1b9f5765ed5fc036d69d75e3afbb53d` (branch `master`, 01/11/2021; repositório parado, último push em 16/11/2021) |

  | Arquivo daqui | O que veio de lá |
  |---|---|
  | `core/hit-events.js` | `functions-lib/src/events/_onHit.ts` — que `mp.makeEventSource` é o caminho para o evento de hit, o formato do payload, e os dois detalhes de depuração (`0x14` é o jogador local; `ctx.getFormIdInServerFormat()` é obrigatório) |
  | `core/espm.js` | `functions-lib/src/` — **que `mp.lookupEspmRecordById` existe**. Só isso: o formato do retorno foi lido de um servidor real, e o uso é outro (eles leem stats para calcular dano; nós lemos `type` para validar digitação) |
  | `core/safe-zones.js` | `functions-lib/src/` — a checagem de `isInSafeLocation` em `hitSync`, e sobretudo **a regra dos dois lados**: proteger só o alvo deixa alguém atirar de dentro da zona para fora dela |

- **A distribuição genérica de eventos de módulo foi avaliada e adiada** — decisão registrada em `core/module-registry.js` e no estudo. O sistema de módulos do Red House entrega `onHit`/`onCellChange` a qualquer módulo que queira escutar; o censo dos seis módulos registrados aqui dá **um consumidor e um tipo de evento** (só `death`, só `hit`), e `onCellChange` não tem nem um — `safe-zones` consulta `locationalData` sob demanda, e território está em Pós-Alfa no backlog. Um despacho genérico trocaria a linha atual (`hitEvents.start(cb)`) por um barramento que serve a um só, com uma chave viva e uma morta desde o primeiro dia.

  O precedente do próprio projeto aponta igual: quando um segundo consumidor apareceu de verdade — governança precisando avisar o painel —, a resposta foi o `panel-refresh-bus`, pequeno e nomeado. **O gatilho de reabertura ficou escrito** junto com o desenho, para que a pergunta não seja redescoberta do zero.

- **Nota no [`PARKED_SERVICES_DECISION.md`](docs/technical/PARKED_SERVICES_DECISION.md) sobre a janela de troca do Red House**, na entrada do `trade-service`. Nada portado: é um ponteiro para quem reativar não começar do zero no desenho da tela, com as três coisas que precisam estar decididas antes (commit duplo, ouro pelo `transaction-service`, atribuição §4 se algo for portado de fato). Ler aquele código antes da reativação é tempo gasto em algo que talvez nunca seja usado.

- **A lista de animações do Red House não é coberta pelo Perfil 1** — avaliação registrada no estudo. Perfil 1 (OAR, Nemesis pré-gerado) entrega o **asset e a paridade**: garante que todo cliente tenha o mesmo behavior graph. O `animList` deles é **seleção pelo jogador** — emote. São camadas diferentes, e o roadmap já sabia disso: a Fase 1 chama-se "Identidade e Emotes" porque emote é feature própria, não subproduto de instalar OAR. Também não é troca de animação de combate.

  **Mas não é "só UI", e por isso não entra agora.** A regra de autoridade do servidor é explícita — o servidor decide *"qual animação de gameplay foi autorizada"* —, então um emote precisa de comando, validação pela `action-policy` (quem está `DOWNED` ou algemado não dança) e a chamada Papyrus que toca. É feature da Fase 1 com as 15 perguntas da §15 pela frente, não item de aproveitamento.

- **`ARCHITECTURE.md` 1.4 descreve os três sistemas** (novas seções 1.4.5–1.4.7), na mesma profundidade de `death-service` e `voip-service`. Eles já estavam em produção e a arquitetura não os mencionava — a mesma classe de problema que motivou boa parte dos achados do QA: configuração ou código que existe e ninguém sabe.

  **Em nenhum dos três há código copiado** — o que atravessou foi técnica, que não é protegida por direito autoral. A atribuição fica registrada assim mesmo: o critério da política é a procedência, não o volume, e no caso do evento de hit a forma é praticamente ditada pela API do Skyrim Platform, o que torna a fronteira entre "reescrito" e "portado" fina demais para se apoiar nela.

### Removido

- **`disguise-service.js` — apagado.** Segunda rodada de avaliação dos PARKED ([`PARKED_SERVICES_DECISION.md` §7](docs/technical/PARKED_SERVICES_DECISION.md)). A primeira rodada classificou `crafting`, `jobs` e `disguise` como "independentes, coerentes"; aquela avaliação é anterior ao `identity-service` ter testes, ao `player-panel-service` existir com aba Social, e ao desenho da Afinidade da Alma fechar.

  Não é só duplicação do `identity-service`: as duas implementações têm **forma diferente**, e a dele é a errada. O `identity-service` resolve nome por `(observador, alvo)`; ele resolvia só por alvo. Sob o `identity-service`, quem não te conheceu já te vê como `Desconhecido` — anonimato é o padrão —, então o único caso que o disfarce precisa resolver é **parecer outra pessoa para quem já te conhece**, e isso é necessariamente por observador. Não havia o que migrar: a estrutura de dados estava errada para o requisito.

  O lugar certo já existe e já estava preparado: `character_known_identities.source` aceita `'disguise'` desde o `schema.sql`, o painel já rotula esse valor como "disfarce", e o [`NAMETAG_IDENTITY_SYSTEM.md`](docs/technical/NAMETAG_IDENTITY_SYSTEM.md) já registrava o requisito como um degrau da escada de exibição, não como serviço paralelo.

  A rolagem de detecção também contradizia desenho fechado: `Math.random()` contra DC, quando o `SOUL_AFFINITY.md` §4.2/§14.3 exige rolagem oculta **determinística e reproduzível** em `audit_logs`, e a §II.2 fechou que o dado nunca diz não — a falha dele devolvia exatamente o "silêncio" que aquele documento lista como assassino de diversão.

  Que nunca foi exercitado dá para provar lendo: `/revealid` respondia *"X é na verdade \<nome de quem digitou o comando\>"*, porque `staffReveal` montava a mensagem com o `actorId` da própria staff; e as duas notificações de `detectDisguise` saíam com `self = null`, que é global — o disfarçado nunca era avisado e todo mundo era. Nada dependia dele. A tabela `disguises` fica, pelo critério das seis órfãs.

### Corrigido

- **O aviso de voz indisponível existia e era apagado meio segundo depois.** `initMicrophone()` já tratava `NotAllowedError` com a mensagem certa — `VOZ INDISPONÍVEL NESTE CLIENT — use o Discord` — e em seguida fechava o WebSocket de sinalização, porque sem microfone não faz sentido manter a conexão pela metade. Só que `ws.onclose` chamava `setStatus('error', 'VOZ DESCONECTADA')` sem condição alguma, e o evento `close` chega no tick seguinte: o chip acabava sempre no texto genérico. O jogador lia "desconectada", que é a consequência, e concluía instabilidade de servidor — o diagnóstico exatamente oposto ao real, que é uma limitação conhecida do client (`docs/technical/VOICE_CLIENT_PATCH.md`).

  Mesmo defeito no `auth_failed`, que também fecha o socket depois de escrever o motivo. Um `state.voiceFatal` marca que já existe um motivo terminal na tela e o `onclose`/`onerror` param de sobrescrevê-lo; `connectVoip` limpa a marca, porque um `/voz` novo é uma tentativa nova.

  **O chip sozinho não resolvia, mesmo consertado.** São 12px no topo da tela: cabe estado, não cabe motivo, e o resto ia para o console do CEF em `localhost:9000`, que ninguém em jogo abre. As três falhas de microfone passam a escrever também no `chat-log` — que já é `pointer-events: none` e some sozinho, então avisa sem travar nada nem exigir clique. O texto do caso `NotAllowedError` diz as três coisas que evitam o ticket errado: não é o microfone do jogador, não é o servidor, e tentar de novo dá no mesmo — use `/voz-criar` no Discord.

  Sem teste automatizado: `skymp/ui/` não tem suíte, `package.json` nem dependência de teste, e criar infraestrutura de front-end do zero para esta mudança não é proporcional. **Fica como pendência de verificação visual** — e é uma pendência mais barata que as da Fase 0, porque não precisa de dois jogadores conectados, só de alguém abrir o client uma vez e rodar `/voz`.
- **Três seções da `ARCHITECTURE` e uma do `QA_REPORT` existiam só em português.** A regra do [`docs/README.md`](docs/README.md) manda atualizar as quatro cópias no mesmo PR, e ela falhou em silêncio duas vezes — que é o modo de falha que ela mesma descreve como pior que tradução ausente.

  **`ARCHITECTURE` 1.4.5, 1.4.6 e 1.4.7** — `hit-events`, `espm` e `safe-zones` — entraram em `bdfab22`, um commit que tocou **um único arquivo**. As três traduções pulavam de 1.4.4 direto para 1.5: quem lesse em inglês, russo ou espanhol não tinha como saber que os três sistemas existem. São exatamente as seções escritas porque "eles já estavam em produção e a arquitetura não os mencionava" — o defeito foi corrigido em português e replicado nos outros três idiomas.

  **`QA_REPORT` §2.15** (cliente com plugin extra passando na verificação de paridade) faltava nas três traduções, que iam de 2.14 para 2.16. É o achado que explica por que o contrato de FormID existe.

  **§2.14 passou a mentir por conta desta rodada**, nos quatro idiomas: ele descreve doze chamadas com nível numérico em cinco módulos PARKED e diz que o problema foi "resolvido na raiz" — só que três desses módulos já não existem e os outros dois foram corrigidos aqui. Ganhou o parágrafo de fechamento.

  **O `README` diverge de propósito e agora está registrado como exceção.** As quatro cópias não têm as mesmas seções — a portuguesa carrega o log de status, as traduzidas carregam tabela de componentes e política de idioma, porque quem chega em outro idioma está avaliando o projeto e não acompanhando o dia a dia. O que importa é que nenhuma afirme o que outra contradiz: o aviso de que nada foi validado com jogador real está nas quatro. Sem a anotação, isso ia oscilar para sempre entre "alarme" e "conserto" errado.

  Verificado por contagem de seções nas 32 cópias, não por leitura; a linha de troca de idioma está nas 32; e `docs/README.md` não tem link morto.

- **3ª varredura por classe de bug conhecida — as cinco passaram limpas.** A auditoria de 06/08 varreu o repositório inteiro; desde ela entraram `soul-service` e a migration v10, o log de moderação do bot, a assinatura do launcher e o fallback de VOIP da UI. Esse código nunca tinha passado pelo filtro. Rodada agora sobre os 42 arquivos de `git diff --name-only 26ed196..HEAD`, e não sobre a lembrança de quais eram.

  **Ouro fora do ledger:** só `core/transaction-service.js` escreve `characters.gold` e `character_inventory`; todo o resto do resultado é mock de teste ou comentário. O `soul-service`, que é o maior código novo, não toca patrimônio — escreve nas próprias quatro tabelas e em `audit_logs`. **`require()` nu:** o arquivo de entrada só tem `require('path')`, que é builtin; o `soul-service` novo entrou como `path.join(gamemodeDir, 'soul-service')`, igual aos outros. **Config que ninguém lê:** as seis famílias de `skymp/config/` têm leitor ativo, e a classe foi estendida para variáveis de ambiente — toda var declarada nos quatro `.env.example` tem quem a leia. **`.gitignore` sem `.env`:** `apps/game-api` e `apps/launcher` não mencionam `.env` no próprio arquivo, e mesmo assim estão cobertos — o padrão `.env` da raiz vale recursivamente. Confirmado com `git check-ignore -v` em vez de leitura, porque ler o `.gitignore` errado é como o buraco apareceria. **`Map` por `actorId` sem limpeza:** `_soulCache` é limpo no `removeActiveCharacter` (por `characterId`, atrás de `isEnabled('soul')`); `activeGatherers` do `jobs-service` se cura sozinho, porque `_finishGather` apaga a chave na primeira linha e todo caminho que abre uma coleta agenda o timer que o chama; `phase0-basic` apaga de `activeUsers` e `userActorMap` nos dois ramos de saída; `moderationLog.js` não guarda estado.

  Dois candidatos ficaram registrados na [§7.6 do `PARKED_SERVICES_DECISION.md`](docs/technical/PARKED_SERVICES_DECISION.md), não corrigidos, porque nenhum é membro das cinco classes e os dois exigem decisão de desenho: o `characterHold` do `economy-regional`, que cresce e nunca encolhe, e o `withdrawHoldTreasury`, que transfere ouro do cofre da cidade para o da facção em duas transações independentes — a forma exata do defeito que o `craftItem` tinha, em tabelas que a busca por `characters.gold` não alcança.

  Sobre o segundo vale a pena ser exato, porque a diferença muda o que fazer: **o ouro não se perde hoje, porque a função nunca chega nos dois `UPDATE`.** Ela morre antes, em `governance.getMembership` — que existe como função e não está no `module.exports` — e usa um `factionInfo` nunca declarado. Os dois já estavam registrados num comentário do `governance-service.js` e aparecem no `typecheck`. São dois defeitos empilhados, e consertar só o de cima seria pior que não mexer: trocaria um caminho que falha alto por um que move ouro pela metade em silêncio.

- **Três comandos de staff negavam para todo mundo, inclusive `owner`.** `/addrecipe`, `/addingredient` (`crafting-service.js`) e `/settax` (`economy-regional.js`) passavam um **nível numérico** para `hasPermission` — `hasPermission(actorId, 20)`, herança de um modelo de permissões que não existe mais. Como `permissions` é um `Set` de strings, `Set.has(20)` é sempre `false`: a checagem nunca explodia e negava em silêncio. Estava registrado como candidato em aberto na [§7.4 do `PARKED_SERVICES_DECISION.md`](docs/technical/PARKED_SERVICES_DECISION.md); a seção passa a registrar a decisão.

  **`/addrecipe` e `/addingredient` exigem `manage_recipes`, permissão nova, `admin` e `owner`.** `add_item` era o candidato óbvio e é o errado: ele significa "dê este item a este jogador" — ato pontual, auditado, raio de alcance de uma pessoa. Uma receita é uma regra permanente que todo jogador usa quantas vezes quiser, uma casa da moeda e não um presente. Reaproveitar `add_item` faria quem auditasse "quem pode `add_item`?" receber a resposta errada sobre quem reforma a economia de crafting — que é a mesma classe do defeito sendo corrigido: uma permissão que significa outra coisa que não o que o nome diz.

  **`/settax` exige `set_gold`, reaproveitada.** Ela já significa "a staff escreve um número da economia por decreto, com audit log", e alíquota de Hold é isso aplicado ao fluxo em vez do saldo. Um nome novo para um único sítio de chamada criaria uma permissão que nenhum cargo concede — o outro modo de falha que o `hasPermission` grita.

  16 testes novos em `parked-staff-permissions.test.js`, separado do `permissions.behavior.test.js` porque o teste "a matriz cobre todo comando de staff que existe" daquele arquivo só enxerga os exports do `admin-service` — estes três handlers moram em outros arquivos, e foi exatamente por isso que o bug atravessou a suíte inteira. Junto vai uma varredura estática que reprova se qualquer arquivo de produção do gamemode voltar a passar número para `hasPermission`; ela pega o quarto caso, o que ainda não existe. Cinco mutações verificadas aplicando e executando: apagar cada uma das três checagens reprova 2, voltar ao nível numérico reprova 3, dar `manage_recipes` ao moderador reprova 3.

  **Não é reativação.** Nenhum dos dois serviços entra no `module-registry.js`. Corrigir a autorização de um serviço estacionado desarma a armadilha que ele guarda para quem o reativar — é o oposto de ligá-lo.

- **A última leitura de vida sobrevivia à desconexão.** `_lastHealth` do `death-service` é chaveado por `actorId`, e o SkyMP reaproveita `actorId` entre sessões — mesma classe do `staffCache` do `admin-service`, que fazia quem entrasse depois herdar o cargo de um admin que já tinha saído.

  Aqui o estrago é pior porque é silencioso e cai justamente na evidência que a staff usa para arbitrar RDM. Alguém sai com 500 de vida, o slot é reaproveitado por outro jogador que entra com 100: o primeiro tick de `checkDamageSpike` lê `previous = 500`, calcula uma queda de 400 e grava um `damage_spike` no contexto de morte. O novo jogador aparece como tendo apanhado sem ter levado um golpe. O caso inverso — sair ferido, entrar cheio — esconde uma agressão real, porque a diferença fica negativa e não passa do threshold.

  Quatro testes, verificados por mutação. Um deles passa pelo `removeActiveCharacter` de verdade em vez de chamar `cleanup` direto: um `cleanup` exportado e nunca chamado seria o mesmo defeito do `.env` que ninguém carregava — existe, tem teste, e não roda em jogo.

  Achado na auditoria estática por classe de bug conhecida, que varreu o repositório inteiro atrás dos outros membros de cinco classes: ouro fora do ledger, `require()` nu, config lida por ninguém, `.gitignore` por app, e cache por `actorId` sem limpeza. As outras quatro passaram limpas.

- **O cabeçalho do `core/proximity-ranges.js` mandava editar o lugar errado.** Ele afirmava que `server-options.*.json` **não** é lido por nenhum código do gamemode e concluía "mexa aqui". Era verdade quando o QA registrou o achado, e deixou de ser quando o `core/server-options.js` nasceu — o próprio arquivo requer o loader vinte linhas abaixo e lê `chat.localRange` e `chat.whisperRange` dele.

  Comentário obsoleto sobre configuração é a mesma classe de defeito que a configuração que ninguém lê: nos dois casos alguém edita um lugar e o jogo não muda. Só que este mandava editar o lugar errado, o que é pior — quem seguisse a instrução trocaria o valor no código e o JSON continuaria vencendo no boot.

- **`characters.gold` não existia em banco migrado** (migration v9). A coluna está declarada no `schema.sql` e em nenhuma migration: banco novo funciona, e quem criou o banco antes dela e aplicou `v2`→`v8` em ordem, como o CONTRIBUTING manda, nunca a recebe. A v2 chega a criar a `gold_transactions` — o ledger da economia — sem garantir a coluna de saldo que esse ledger acompanha. Não quebra o boot: quebra na primeira operação de ouro, que é todo o `transaction-service`. Achado pelo `npm run check:schema` ao preparar a Fase 0, que é exatamente a classe de problema para a qual ele foi escrito.

- **Dois defeitos que só o primeiro boot real revelou.** O servidor SkyMP foi instalado e subiu com o gamemode pela primeira vez no projeto — quatro módulos ativos, 33 comandos, banco conectado.

  O primeiro: **`Cannot find module 'dotenv'`, e o gamemode não carregava**. O SkyMP copia o arquivo de entrada para `%TEMP%` e executa de lá — está escrito no topo do próprio arquivo, e é por isso que todos os requires dele usam caminho absoluto. O do dotenv, adicionado neste ciclo, era o único nu. Passou nos testes e no CI porque os dois rodam a partir de `skymp/gamemode/`. É o exemplo mais limpo do que o cabeçalho do `ci.yml` já avisava: *"CI verde significa que não quebrou o que já era verificado, não que funciona em jogo"*.

  O segundo: **nenhuma opção de gameplay era lida**. O `.env.example` definia `NODE_ENV=development`, o loader monta `server-options.<NODE_ENV>.json`, e o projeto só tem `local` e `production`.

- **`database.js` não tinha `close()`**, e o `verify-governance-market-stalls.js` já chamava `db.close()` atrás de um guard que nunca disparava. `RUN_DB_CHECK=1 npm run test:systems` imprimia "10/10 passaram" e ficava pendurado para sempre (exit 124 por timeout; agora exit 0). Num CI com banco, o job só terminaria no timeout e o relatório diria "cancelado".

### Alterado

- **"Se voice chat é obrigatório" deixou de ser decisão em aberto** (§13 do [`SKYMP_RP_DEVELOPMENT_PLAN.md`](SKYMP_RP_DEVELOPMENT_PLAN.md)). Na prática o projeto já tinha decidido — o "Não fazer" do [`QA_REPORT_2026-08.md`](docs/technical/QA_REPORT_2026-08.md) manda não perseguir o VOIP nativo antes do resto, e o [`VOICE_CLIENT_PATCH.md`](docs/technical/VOICE_CLIENT_PATCH.md) explica por quê. Faltava estar escrito no documento que lista as decisões pendentes, e enquanto não estivesse, quem consultasse aquela seção leria que o assunto ainda estava aberto.

  Fica registrado: voz nativa por proximidade é **opcional, fase `lab`, Pós-Alfa**, não é pré-requisito de lançamento; os canais de voz do Discord são a solução da Alfa e da Beta fechada. O motivo é custo, não desinteresse — o patch de client nunca foi compilado, as três PRs upstream foram auto-fechadas pelo autor sem review, e refazê-lo exigiria fork e manutenção de um client C++. A entrada diz também como voltar atrás, porque `voip-service.js` está pronto e testado do lado servidor: é destravar peça existente, não reescrever.

  A `ARCHITECTURE.md` 1.4.4 afirmava, no presente, que a decisão seguia em aberto — documentação que não reflete a decisão real engana igual a config que ninguém lê. Passa a apontar para a decisão fechada.

- **`crafting` e `jobs` passam a mexer em item pelo `core/transaction-service`.** `housing`, `horse` e `trade` já tinham sido migrados quando o `economy-service` foi apagado; o que faltava era o teste que trava a migração, e os dois casos que a primeira rodada não viu porque procurava por **ouro**.

  O `craftItem` anunciava `// transação segura: tudo ou nada` e era um laço de `removeItem()` independentes seguido de `giveItem()`, cada um abrindo a própria transação. Receita de três ingredientes eram quatro transações: falhando a segunda, a primeira já commitou, o jogador perdeu o ingrediente e não recebeu nada. É `economy-service.transfer` com outro substantivo. Virou uma transação só, pelas primitivas `tx.*`, no mesmo formato da compra em barraca.

  O `hasItem` que checava estoque antes saiu junto: ele lia **fora** da transação, então entre a checagem e o consumo o item podia ter saído por outro caminho. `applyInventoryDelta` lê com `FOR UPDATE` e lança se faltar — estritamente melhor.

  O `jobs-service` era pior: entregava recurso por `AddItem` do Papyrus direto, **sem banco e sem ledger** — lenha, minério e peixe não existiam para o servidor, só para o cliente, até a próxima sincronização ler o banco que nunca soube deles. Inverte a regra que o resto do projeto segue: inventário só existe se o MariaDB confirmar.

  Junto vieram duas coisas que a migração tornou obrigatórias: a coleta precisa resolver `characterId` (o banco não fala em `actorId`), e por isso o `activeGatherers` deixou de ser chaveado por `actorId`; e o fecho confere que o slot ainda é da mesma pessoa antes de creditar — passam 10 a 20 segundos ali, e sem a checagem o recurso ia para o personagem errado **com** o ledger registrando corretamente o dono errado, que é pior que não entregar.

  **Nenhum dos cinco foi registrado no `module-registry`.** Migrar é segurança interna; reativar é decisão de escopo, e misturar as duas foi o erro que a Fase 2 do QA existe para não repetir.

  14 testes novos, verificados por mutação: `housing` voltando ao `UPDATE characters SET gold` reprova 2, `crafting` voltando às funções públicas reprova 3, `jobs` voltando ao `AddItem` direto reprova 2. A asserção central não conta linhas de ledger — soma o que o ledger diz e compara com o que o saldo fez de fato, para pegar qualquer caminho novo de ouro e não só os que existem hoje.

  O critério que a primeira rodada deixou escapar ficou registrado na §7.5 daquele documento: a pergunta é *"toca patrimônio, estado ou identidade fora do dono desse assunto?"*, não *"importa o arquivo errado?"*.

- **`SKYMP_RP_DEVELOPMENT_PLAN.md` §14 reescrita.** Apontava para **Housing** ou "refinar combate/física" e era anterior a `hit-events`, `espm`, `safe-zones`, `core/soul.js` e ao primeiro boot real. Passa a dizer o que é verdade: o próximo passo não é uma feature, é conectar um cliente — hoje são **quatro** sistemas com o aviso *"confirmado por teste automatizado, não confirmado em sessão real"*, e a Fase 0 é o que desbloqueia todos.

### Otimizado

- **O painel só lê vitais de quem está olhando a aba Status.** O laço lia vida/magicka/stamina — três chamadas Papyrus — para todo painel aberto a cada 2 s, inclusive o de quem estava na aba Social. A 13–35 ms por ida ao Papyrus (medição do Red House), são ~450 ms de cada janela com 10 painéis, gastos atualizando um número que ninguém está vendo. O diffing que já existia não ajudava: ele evita reenviar, não evita ler.

  A informação para evitar isso já chegava e era descartada — a UI manda `panel:refresh:<aba>` a cada troca. Nenhuma mudança na UI. Os testes contam as chamadas Papyrus de um tick, que é a única forma de provar a economia: o comportamento visível não muda, então nenhum teste de resultado pegaria a regressão.

- **`core/soul.js` guardava dois caracteres invisíveis com significado.** O arquivo contava como binário para o `grep` e para o `file`, e a causa não era a que parecia: além da classe de marcas combinantes crua no `normalize()` (`U+0300`–`U+036F`), havia um **byte NUL** no separador do material assinado — `].join('<NUL>')`, que se lê na tela como `].join('')`.

  O NUL é uma escolha deliberada e correta: ele não sobrevive ao `normalize()`, então nenhum jogador consegue escrevê-lo na ficha. Com um separador digitável, mover uma letra de um campo para o seguinte (`'ab'+'c'` contra `'a'+'bc'`) assinaria o mesmo material, e duas fichas diferentes nasceriam com a mesma alma. O problema nunca foi a escolha — foi ela estar invisível: quem lesse a linha entenderia o oposto, e qualquer editor que limpe caracteres de controle ao salvar mudaria a semente de **toda alma já derivada**, sem erro nenhum aparecer.

  Os dois viraram escape (`'\u0000'` e `[\u0300-\u036f]`), com o separador em constante nomeada. Verificado que as sementes não mudaram: quatro almas derivadas antes e depois batem byte a byte, incluindo o par que testa a fronteira entre campos.

  Ganhou também um teste de valores dourados — a derivação é um formato de dados, não código livre: mexer em `normalize`, na ordem dos campos ou no separador reescreve a alma de todo personagem que já existe. Agora isso reprova em vez de acontecer em silêncio.

- **A compra em barraca tinha a própria implementação de "como mexer em ouro".** `buyItem` escrevia o SQL de saldo e de inventário à mão dentro da transação dele — atômico e com ledger, então não era inseguro, mas era uma segunda implementação fora do arquivo que existe pra ser a única. O `SELECT ... FOR UPDATE` do saldo e a guarda de saldo negativo estavam duplicados, e correção no `core/transaction-service` não alcançava a compra.

  Não dava pra resolver chamando as funções públicas do `transaction-service`: cada uma abre a própria transação, e a compra move ouro, baixa estoque, credita o vendedor, cobra imposto e entrega o item — ou tudo commita junto, ou o comprador fica sem ouro e sem item. As primitivas internas já recebiam a conexão como argumento; passaram a ser exportadas como `tx.*`, com o contrato explícito de que quem chama é dono da transação.

  Junto: `err.message` ia direto pro jogador no `catch`, inclusive quando era erro de SQL — nome de tabela e coluna na tela de quem clicou em comprar. As mensagens de regra continuam passando; o resto vira uma frase genérica e o detalhe fica no log.

  `buyItem` não tinha **nenhum** teste de comportamento — o único que existia conferia que a função estava exportada. Ganhou 10, verificados por mutação: remover um lançamento do ledger reprova, e trocar as primitivas pelas funções públicas (quebrando a transação única) reprova em três.

- **O `npc-cleaner` apagava o mundo, e implementava a opção que a decisão técnica rejeitou.** Ele varria `mp.getActorsByProfileId(0)` e chamava `disable` **e `delete`** em todo ator encontrado, pulando apenas os de uma allowlist — que estava vazia, com um comentário "adicione IDs base de mercadores essenciais aqui". Na prática: mercadores, guardas e NPCs de quest apagados a cada 60 segundos, e `delete` numa referência persistente não volta. O [NPC_POLICY_DECISION](docs/technical/NPC_POLICY_DECISION.md) avaliou três opções e escolheu a **C — Vanilla Spawn Seletivo**; o código implementava a B, rejeitada, na forma mais extrema.

  Três inversões: a lista virou **de bloqueio** (lista vazia agora remove nada em vez de tudo — o modo de falha aponta pro lado seguro), o `safeRadius` **passou a existir de verdade** (era declarado com o comentário "limpa apenas NPCs longe dos players" e nunca lido: o comentário descrevia um recurso que não estava escrito), e o `delete` saiu — só `disable`, que é reversível. A lista guarda `baseDesc` e não FormID numérico, porque o primeiro byte de um FormID é o índice de load order. Config em `skymp/config/npc-policy.json`, serviço inerte enquanto ela não for curada. 8 testes, onde antes não havia nenhum.

  Isto ficou mais urgente com a correção do `.env` abaixo: até ela, ligar `ENABLE_NPC_CLEANER=true` não fazia nada.

- **`/setgold` era o único caminho de dinheiro que escapava do ledger.** Fazia `UPDATE characters SET gold = ?` direto — sem transação e **sem linha em `gold_transactions`** —, que é exatamente o padrão que motivou apagar o `economy-service.js`. É também o comando que mais precisa de rastro: ouro que aparece na conta de um jogador sem origem registrada é indistinguível de duplicação por bug, e quem pode fazer isso é justamente a staff. O `audit_logs` guardava a intenção do comando; o saldo deixava de fechar com a soma do ledger.

  Passou pelo `core/transaction-service`: o valor absoluto vira leitura + delta, com `reason='staff_setgold'`. Junto veio um guard que faltava — `/setgold <id>` sem valor passava `NaN`, que o MySQL grava como `0`, então um erro de digitação zerava o patrimônio do jogador em silêncio.

  O teste da matriz de permissões aferia esse comando observando o `UPDATE` cru, ou seja, o próprio padrão proibido. A sonda passou a exigir que o ouro tenha se movido **e** que a movimentação tenha virado linha no ledger — mais forte que antes, e verificada por mutação.

- **O gamemode nunca carregou o próprio `.env` — nenhum módulo `lab` jamais subiu.** `dotenv` estava em `dependencies`, o `.env.example` existia, e tanto o [CONTRIBUTING](CONTRIBUTING.md) §1 quanto o [roteiro da Fase 0](docs/technical/FASE_0_ROTEIRO.md) mandavam preencher `skymp/gamemode/.env`. Nenhum arquivo do gamemode chamava `require('dotenv')`. Quem lia esse arquivo era o `apps/web/server.js`, para si mesmo — o que tornava a falha invisível: o arquivo existia, era lido por alguém, e mesmo assim as flags não chegavam. `module-registry.bootAll()` via `process.env[ENABLE_*]` sempre indefinido, então governança, barracas, morte, painel e VOIP ficavam desligados de forma permanente. Sem erro: o log dizia `DESATIVADO (... não definido)`, exatamente o que diria se a pessoa tivesse escolhido desligar.

  O check `flags de ambiente` dava `[PASS]` durante todo esse período porque só conferia que a string existia no `.env.example` — provava que alguém escreveu a linha, não que ligar a linha fazia algo. Foi substituído por um que verifica o carregamento **e a ordem** (o `.env` precisa vir antes do registry e do `server-options`, que leem o ambiente em tempo de require, não de boot).

- **Cargo de staff sobrevivia à desconexão e era herdado pelo próximo jogador.** `admin-service.removeStaffRole` existia, era exportada e tinha teste — e nenhum caminho de produção a chamava. O cache é chaveado por `actorId`, que o SkyMP reaproveita entre sessões, e `registerStaffRole` só roda no login: quem entrasse no `actorId` de um admin que saiu herdava `ban`, `set_gold` e `retire_character`. Não aparecia em nenhum teste de permissão porque o cargo estava correto nos dois momentos — o defeito era de sessão, não de autorização.

- **Módulo PARKED podia ser ligado por fora do `module-registry`.** O `governance-service` decidia se o `economy-regional` roda lendo `process.env.ENABLE_REGIONAL_ECONOMY` direto, em dois pontos: a flag no `.env` bastava para carregar e executar um módulo estacionado sem resolução de dependência, sem registro de comando e sem shutdown — o oposto do que o registry existe para garantir. Passou a usar `moduleRegistry.isEnabled()`. Nenhum módulo foi reativado.

- **Resíduos da forma antiga de chamada Papyrus** (achado 2.13). A conversão das 22 chamadas se manteve, mas o `market-stalls-service` tinha o FormID cru como *fallback* quando `mp.getDescFromId` some — caindo justamente na forma inválida, e de um jeito que culpa o asset no log em vez de acusar o contrato. Junto: `death-service` e `player-panel-service` construíam `{type,desc}` inline em vez de usar `actorRef()`, e o `jobs-service` guardava uma chamada comentada com a forma errada logo acima de um `TODO: Descomentar`. Agora há um guard estático que varre o gamemode inteiro, **PARKED incluído** — que é onde a forma antiga voltaria sem nenhum teste de comportamento perceber.

- **`.env.example` desalinhado em dois apps.** O do gamemode oferecia `ENABLE_JUSTICE_SERVICE`, `ENABLE_FACTION_SERVICE` e `ENABLE_SURVIVAL_SERVICE` — flags dos três serviços **apagados** em 06/08 — e omitia governança, barracas e painel, que existem. O do painel web não documentava `TRUST_PROXY`, `NODE_ENV` nem `LAUNCHER_REDIRECT_URIS`, todos lidos pelo `server.js`. `TRUST_PROXY` é o que mais custa em silêncio: sem ele atrás de um proxy reverso o Express enxerga o IP do proxy, e o rate limit passa a contar o mundo inteiro como um visitante só — continua "funcionando" sem proteger nada.

- **Cliente com plugin extra passava na verificação de paridade.** As duas checagens percorriam a lista do servidor perguntando "o jogador tem isto?"; nenhuma percorria a do jogador perguntando "o servidor conhece isto?". Um cliente com todos os mods certos, com o hash certo, **mais um `.esp` a mais**, era aprovado — e um plugin extra ocupa um índice na load order e desloca todos os seguintes, então o `base_id` gravado no banco passa a apontar para outro item na tela daquele jogador. Sem erro, sem log, sem crash: um baú com outra coisa dentro. Junto veio um segundo caso — load order ausente fazia a checagem comparar o jogador consigo mesmo e responder `ok`, que é a pior resposta possível porque parece aprovação. Ver QA 2.15.

### Adicionado

- **Etapa 9 do [roteiro da Fase 0](docs/technical/FASE_0_ROTEIRO.md)** — os três sistemas vindos do Red House nunca rodaram com cliente conectado. O primeiro boot real validou o servidor sozinho; estes só executam quando alguém entra.

  O passo que mais importa é `9.1.4`: o cliente reporta `0x14` para si mesmo, e se o servidor não trocar pelo `pcFormId` o lado de quem bateu não resolve para personagem nenhum. O estudo aponta esse como o detalhe mais fácil de errar, e ele **não aparece como erro** — aparece como um `null` numa coluna de JSON. Para `espm`, o caso decisivo é `/additem 0x14`: a API devolve `{}` para o Player, e `{}` é truthy, então "o item foi entregue" é exatamente o sintoma de a checagem ter virado `if (r)`.

  **`safe-zones` só pode ser testado até a metade, e a etapa diz isso.** Falta o pré-requisito óbvio — `skymp/config/safe-zones.json` não existe, só o `.example.json`, e sem ele o módulo responde "não há zona nenhuma" —, mas falta também um chamador: a checagem de lugar só roda quando quem invoca `actionPolicy.canPerform` informa `context.actorId`, e nenhum dos quatro chamadores atuais informa. Então a etapa verifica que a config carrega e que categoria inválida grita, não que a zona barra. Ligar um chamador é decisão de política, não passo de teste — ficou registrada como pendência no log da Fase 0.

- **[Roteiro da Fase 0](docs/technical/FASE_0_ROTEIRO.md)** — o teste in-game passa a ser um procedimento de ~50 min com passos, o que observar, o que significa falhar, e um registro para preencher enquanto testa. O plano anterior era de 13/07 e cobria só governança e barracas; desde ele entraram morte, painel, VOIP, master API e fila.
- **Primeiros testes do launcher** (24) — ele tinha zero, e é o programa que todo jogador roda. A lógica de paridade saiu de dentro dos handlers `ipcMain` para `electron/parity.mjs`, sem `fs`, sem `http` e sem `electron`: as dependências de I/O entram como argumento, e o cabeçalho TES4 é testado com um plugin sintético de 60 bytes em vez de um `.esm` de 300 MB. O launcher entrou na matriz de testes do CI.

- **`core/soul.js` — a camada de domínio da Afinidade da Alma**, com 28 testes. Função pura: gerador com orçamento fixo, bandas, semente derivada da ficha e resolução em quatro resultados. Não depende da Fase 0 porque não toca no jogo — o serviço, que toca, continua bloqueado.

  O número que valida o desenho: **`surdo` com mestre e componente dá exatamente a mesma distribuição que `raro` sozinho** (25/40/25/10). A afinidade não fecha porta — ela decide de quanta gente você vai precisar.

- **[Afinidade da Alma](docs/design/SOUL_AFFINITY.md) — desenho fechado**, e a **Constituição vai a v1.1** (a §8 deixa de ser "Soul DNA"). Sistema único que explica magia, encantamento, corrupção, vampirismo, licantropia e linhagem. Três partes: análise de 15 pontos, o desenho que preserva a diversão, e a especificação.

  As decisões que fecharam o desenho: **o dado nunca diz não** (Limpo/Caro/Complicado/Marcado — os quatro dão certo); **nenhuma alma é estritamente melhor**, garantido por orçamento fixo no gerador e não por boa vontade; **a alma vem da ficha aprovada**, o que mata o reroll-farming e faz a aplicação de whitelist valer mecanicamente; **as marcas são a progressão** — não há nível, há o que ficou em você; e **prazo em sessões, não em meses**.

  Vetado: a mordida com 70% de morte, que transformaria qualquer vampiro num `/permakill` ambulante. No lugar, infecção com janela de escolha entre curar, esconder ou aceitar.

- **[CONSTITUICAO.md](docs/CONSTITUICAO.md) v1.0** — a constituição de design do projeto. Define que não estamos construindo um servidor, mas um mundo persistente capaz de produzir histórias por anos sem depender da staff; que toda mecânica responde "como isso gera histórias?" ou é descartada; e que todo poder cobra um preço. Vampirismo e licantropia são maldições com política e perseguição, nunca buffs. Nada de dinheiro, craft ou loot infinito.

  O **Anexo A** é parte do documento e registra as sete tensões que a própria constituição cria — entre elas: aplicar "nunca implementar primeiro" sem limite congelaria o teste in-game, que é o único bloqueio real do projeto; "sistema que depende da staff" lido ao pé da letra proibiria a whitelist; e uma economia de NPC conduzida por Papyrus não escala, dado o custo de 13–35 ms por chamada.

- **Verificação de drift de schema** (`npm run check:schema`) — as migrations `v2`–`v8` são aplicadas à mão e nada conferia que todas tinham sido aplicadas. Um banco meio-migrado não quebra o boot: o servidor sobe, o login passa, e só a query que toca a coluna faltante falha, às vezes semanas depois, numa cena, com ouro no meio. O check lê `schema.sql` + migrations como fonte da verdade e confronta com `information_schema`. Roda no `Start-AllServices.ps1` e, na forma `--list` (sem banco), no CI.
- **Teste de comportamento de permissão por cargo** (`permissions.behavior.test.js`) — matriz explícita de cargo × comando, chamando os handlers reais e olhando o efeito colateral, não o retorno. Pega as duas falhas que o teste unitário não pega: handler que esqueceu de chamar `hasPermission`, e cargo alargado em silêncio. Verificado por mutação: remover o gate do `/setgold` quebra o teste.
- **Testes do `identity-service`** — o sistema que sustenta o disfarce (o nome exibido depende de quem está olhando) não tinha teste nenhum. Fixa o contrato: desconhecido é "Desconhecido", conhecimento não é recíproco, e sem observador nunca se revela nome civil. Qualquer integração futura que vaze o registro civil falha aqui em vez de arruinar uma cena.
- **[OPERATIONS.md](docs/technical/OPERATIONS.md)** — runbook de operação: pré-boot, diagnóstico de schema, matriz de quem pode o quê, portas, segredos, e uma seção honesta do que ainda não é coberto.

Total de testes: **496** (362 gamemode + 40 web + 30 game-api + 24 launcher + 40 bot) + 13 checks de sistema. Contagem conferida rodando as cinco suítes em 07/08/2026 — a linha anterior dizia 301 e nenhuma das parcelas ainda batia. O roteiro da Fase 0 pedia "253 passando" no passo 0.1, que é o primeiro passo do teste: um testador pararia ali achando que quebrou alguma coisa.

- **Documentos de entrada em russo e espanhol** — `README`, `CONTRIBUTING` e `SECURITY` agora existem em quatro idiomas (`.md`, `.en.md`, `.ru.md`, `.es.md`), com linha de troca de idioma no topo de cada um. Russo porque é a língua nativa da comunidade SkyMP: o upstream e o Red House são russos, e até aqui um dev russo caía num repositório que não sabia ler. Espanhol pelo alcance na América Latina, onde a comunidade de Skyrim é grande e o português já é vizinho.

A documentação técnica profunda continua **só em português**, por decisão registrada em `docs/README.md`: são muitos documentos que mudam com frequência, e tradução desatualizada é pior que tradução ausente.

---

## [0.1.0] — 2026-08-06

Primeira versão marcada. Consolida a auditoria completa do monorepo, a pesquisa no SkyMP upstream e a adoção de AGPL-3.0 como build pública.

### Adicionado

- **`apps/game-api`** (porta 7758) — o serviço que o launcher sempre chamou e que não existia. Serve `/mods.json` (paridade de modpack), fila de entrada com capacidade e expiração de reserva, e endpoints internos de sessão. Manifesto ausente responde 503, nunca lista vazia.
- **Master API de sessão** no `apps/web` (`GET /api/servers/:masterKey/sessions/:session`) — contrato nativo do SkyMP que tira a identidade das mãos do cliente. Com `offlineMode: false`, o `profileId` passa a vir do painel, que é quem autenticou o Discord.
- **Tipagem da API `mp`** (`skymp/gamemode/types/mp.d.ts`) — não existe typings públicos do SkyMP. Marca a procedência de cada assinatura (`[DOC]` vs `[USO]`).
- **`core/server-options.js`** — carrega, valida e aplica `server-options.json`, que antes era gerado e documentado mas nunca lido. Oito opções ligadas de verdade; valor inválido aborta o boot.
- **`core/papyrus.js`** — helpers `actorRef`/`baseRef` para o formato correto do `self` nas chamadas Papyrus.
- **`core/proximity-ranges.js`** — fonte única dos raios de chat e voz.
- **Autoria de morte** via `mp.onDeath(actorId, killerId)`, gravada em `audit_logs`. É atribuição, não a inferência por proximidade.
- **Morte permanente** opcional (`rp.permadeathEnabled`).
- **Ouro inicial** por personagem (`economy.startingGold`), concedido uma vez só via chave de idempotência.
- **Migrations v6, v7 e v8** — tickets de lançamento, índices das queries quentes, sessões de jogo.
- **Rotação de crash reports** por idade e por contagem.
- **CI no GitHub Actions** — 4 suítes, checks de sistema, typechecks, e higiene (nenhum `.env` ou asset da Bethesda versionado).
- **Documentação de contribuição**: `CONTRIBUTING`, `SECURITY`, `CHANGELOG`, índice em `docs/README.md`, templates de PR e issue — em português e inglês nos pontos de entrada.
- **`LICENSE`** (AGPL-3.0) — o projeto não tinha licença nenhuma, o que legalmente significava "todos os direitos reservados" e impedia a build pública.
- **Documentos novos**: contrato mods × gamemode, distribuição pelo launcher, referência do SkyMP upstream, guia da build pública, decisão sobre serviços PARKED, relatório de QA.

### Corrigido

- **Launcher não carregava configuração nenhuma.** Lia `process.env.VITE_*` sem nada colocar valores lá — login do Discord impossível, servidor sempre localhost, updater desligado. As sete variáveis do `.env.example` nunca tiveram efeito.
- **Client secret do Discord embutido no instalador.** A troca de token migrou para o painel; o launcher recebe só o perfil público.
- **Aprovar whitelist ressuscitava personagem `retired`**, desfazendo `/permakill`.
- **22 chamadas Papyrus com o argumento errado** — passavam FormID cru onde os testes oficiais do SkyMP usam objeto `{type, desc}`. A suíte passava porque o `mp` mockado aceita qualquer coisa.
- **Raios de chat e voz divergentes** — quem estava no alcance do sussurro escrito ficava fora do falado.
- **`.env` fora do `.gitignore`** em `apps/bot-discord` (onde vive o token do bot) e `apps/launcher`.
- **`electron/` nunca foi typechecked**; e `npm run build` rodava `tsc` num solution file que não checava projeto nenhum.
- **Porta do launcher** divergia da do servidor (7757 vs 7777).
- **`hasPermission` aceitava número em silêncio** — `Set.has(20)` num Set de strings sempre nega.
- **`DATE(created_at)=CURDATE()`** no dashboard impedia uso de índice.
- **CORS e callback do Discord** presos a `localhost`.
- **Endpoint de manifesto morto** com `dummy_hash_for_testing` no painel.
- **Validação de entrada** em `/api/apply`.

### Removido

- **`economy-service.js`** — mexia em ouro com `UPDATE` solto, sem transação nem ledger; o `transfer` podia fazer ouro sumir. Seis módulos o importavam. Os que ficaram foram migrados para `core/transaction-service`.
- **`justice-service.js`** — superseded pelo `governance-service`, que tem alcance, plantão, auditoria e permissões nomeadas.
- **`faction-service.js`** — mantinha um modelo de associação concorrente com `governance_memberships`. Facção é um escopo da governança.
- **`survival-service.js`** — mexia em `ActorValue`, que é o que o `death-service` lê para detectar `DOWNED`.
- **Documentos consumidos**: estudos de referência já absorvidos pelo backlog e pela arquitetura, snapshots de máquina, e um doc que argumentava sobre um endpoint que ninguém usava.

### Segurança

- Fila autenticada por ticket de uso único emitido pelo painel, em vez do `discordId` que o cliente informa.
- Tickets e sessões guardados como hash SHA-256 — vazamento do banco não vira credencial.
- `redirect_uri` do OAuth validado contra allowlist.
- Rate limiting nos endpoints públicos do painel e da API do jogo.

### Sabidamente não pronto

Listado aqui de propósito, porque uma build honesta sobre suas lacunas é mais útil que uma que promete demais:

- **Nada foi validado em jogo.** Todo o gamemode é verificado com `mp` mockado.
- **Instalador não assinado** — SmartScreen bloqueia.
- **`mods.json` precisa ser gerado** de uma pasta `Data/` real antes de qualquer jogador conseguir entrar.
- **Polling de 2s** ainda existe no `death-service` e no `player-panel-service` como rede de segurança, e é caro (cada chamada Papyrus custa dezenas de ms).
- **VOIP nativo** depende de um patch de client que não existe upstream; a alternativa são canais de voz do Discord.

[0.1.0]: https://github.com/vinicius3232/skymp-heavy-rp/releases/tag/v0.1.0
