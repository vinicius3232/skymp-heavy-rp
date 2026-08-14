# Documentação

Mapa dos documentos do projeto. Se você acabou de chegar, leia na ordem da primeira seção.

> **Última conferência contra o código: 11/08/2026.** README, arquitetura, plano principal, design da Alma, roadmap ativo e changelog foram reconciliados com o commit `c23179d`. Documentos de handoff e pesquisa são registros datados: quando superados, preservam o contexto histórico e recebem aviso explícito. Se você encontrar um documento afirmando algo que o código não faz, isso é um bug — [abra uma issue](https://github.com/vinicius3232/skymp-heavy-rp/issues) ou corrija no seu PR.

---

## Comece por aqui

| # | Documento | Por quê |
|---|---|---|
| 0 | [CONSTITUICAO.md](CONSTITUICAO.md) | **A constituição de design.** O que o projeto é, o que nunca criar, e por que toda mecânica precisa responder "como isso gera histórias?". O Anexo A traz as tensões conhecidas dela. |
| 1 | [QA_REPORT_2026-08.md](technical/QA_REPORT_2026-08.md) | **O estado real de cada componente**, incluindo o que não está pronto e o plano priorizado. É o documento mais honesto do projeto. |
| 2 | [ARCHITECTURE.md](ARCHITECTURE.md) | Como banco, painel web, bot, API do jogo, launcher e gamemode conversam. |
| 2.1 | [research/ADMIN_PLATFORM_AUDIT.md](research/ADMIN_PLATFORM_AUDIT.md) | **O estado real do painel de staff.** Doze rotas administrativas, zero verificações de permissão — e o que mais a auditoria de 13/08 encontrou. Leia antes de `skyadmin/`. |
| 2.2 | [skyadmin/README.md](skyadmin/README.md) | Centro de orientação do painel de staff: escopo, arquitetura, plano, segurança, operação e referências. **É projeto, não estado** — ver a §7 da auditoria acima. |
| 3 | [../CONTRIBUTING.md](../CONTRIBUTING.md) | As regras que não são óbvias lendo o código. Quase todas existem porque alguém já quebrou aquilo. |
| 4 | [../CHANGELOG.md](../CHANGELOG.md) | O que mudou em cada versão — e o que sabidamente não está pronto. |

---

## Técnico

### Entender a plataforma

| Documento | Sobre |
|---|---|
| [research/SKYMP_INTEGRATION_AUDIT.md](research/SKYMP_INTEGRATION_AUDIT.md) | **Auditoria de 14/08 da fronteira com o SkyMP.** Nenhum dos problemas do Heavy RP exige patch — mas seis chamadas nossas usam API que não existe, e uma delas derruba todo jogador conectado em dois segundos. **Leia antes de qualquer sessão de teste.** |
| [SKYMP_UPSTREAM_REFERENCE.md](technical/SKYMP_UPSTREAM_REFERENCE.md) | A API real do SkyMP, incluindo hooks que a documentação oficial não menciona. Onde achar a verdade quando a doc é omissa. |
| [SKYMP_COMPATIBILITY_MATRIX.md](technical/SKYMP_COMPATIBILITY_MATRIX.md) | **A única declaração de versão do projeto** — SkyMP, Skyrim, SKSE, SkyrimPlatform, modpack — mais o procedimento de atualização e as três camadas de teste que ela exige. |
| [PAPYRUS_USAGE_POLICY.md](technical/PAPYRUS_USAGE_POLICY.md) | As 128 funções Papyrus que o servidor implementa, classificadas em REQUIRED/SAFE/LIMITED/AVOID. Chamar qualquer outra devolve `null` em silêncio. |
| [PLUGIN_LOAD_ORDER_STRATEGY.md](technical/PLUGIN_LOAD_ORDER_STRATEGY.md) | Por que o primeiro byte do FormID é o índice do plugin, por que **ESL não existe no SkyMP**, e o que o nosso gate de paridade ainda deixa passar. |
| [SKYMP_PATCH_POLICY.md](technical/SKYMP_PATCH_POLICY.md) | Quando patch, quando adapter, quando extensão de cliente, quando PR — e o que mudou quando o upstream passou a exigir cessão de direito autoral. |
| [`core/skymp-adapter/`](../skymp/gamemode/core/skymp-adapter/README.md) | A fronteira declarada contra o motor: identidade, Papyrus e detecção de capacidade. Só os boundaries que a auditoria provou instáveis. |
| [MODS_AND_GAMEMODE_CONTRACT.md](technical/MODS_AND_GAMEMODE_CONTRACT.md) | O que acontece com um mod dentro de um cliente conectado. Responde "esse mod funciona no servidor?" com critério. |
| [SKYMP_SERVER_SETUP.md](technical/SKYMP_SERVER_SETUP.md) | Instalação e configuração do servidor SkyMP. |
| [OPERATIONS.md](technical/OPERATIONS.md) | Runbook: subir, conferir schema, quem pode o quê, portas, e o que fazer quando algo dá errado. |
| [SERVER_OPTIONS_SCHEMA.md](technical/SERVER_OPTIONS_SCHEMA.md) | Opções de gameplay — **e quais delas realmente fazem efeito hoje**. |

### Distribuição e publicação

| Documento | Sobre |
|---|---|
| [LAUNCHER_DISTRIBUTION.md](technical/LAUNCHER_DISTRIBUTION.md) | Como cliente e modpack chegam ao jogador, como a paridade é verificada, e a assinatura do instalador (§6). |
| [PUBLIC_BUILD_GUIDE.md](technical/PUBLIC_BUILD_GUIDE.md) | O que precisa estar verdadeiro antes de publicar a build pra comunidade. |
| [LICENSE_AND_AFFILIATION_POLICY.md](technical/LICENSE_AND_AFFILIATION_POLICY.md) | Licenças do SkyMP por subprojeto, o que cada situação obriga, e não-afiliação. |
| [SKYVOICE_PRODUCTION_READINESS.md](technical/SKYVOICE_PRODUCTION_READINESS.md) | **Comece por aqui para saber se a voz está pronta. Ela não está.** Relatório final da Etapa 4, com a tabela FEATURE/STATUS/TEST/RESULT/RISK, os números medidos (200 jogadores **simulados**, p95 de 11.7 ms) e o gargalo que decide a arquitetura: o relay legado precisaria de ~5,3 Gbit/s dentro do processo do gamemode num evento de 200 pessoas. Três bloqueios críticos continuam abertos. |
| [SKYVOICE_SECURITY_AUDIT.md](technical/SKYVOICE_SECURITY_AUDIT.md) | Auditoria de segurança completa, e os três defeitos reais que ela achou — entre eles o gateway do LiveKit que **nunca falou com o SFU** porque nenhum caminho de produção passava um emissor de token de operador. Privacidade executável: uma varredura que reprova gravação, vídeo, flags de CEF inseguras e rádio. |
| [SKYVOICE_DEPLOYMENT.md](technical/SKYVOICE_DEPLOYMENT.md) | Subir e operar: portas, firewall, DNS, TLS, TURN, health checks, restart, logs, troubleshooting, e como trocar self-hosted ↔ Cloud sem tocar em gameplay. Os arquivos estão em `deploy/livekit/` — e **nenhum `docker compose up` foi executado contra eles**. |
| [SKYVOICE_LIVEKIT_AUDIT.md](technical/SKYVOICE_LIVEKIT_AUDIT.md) | **A origem da arquitetura de voz.** Auditoria do VOIP atual + validação do LiveKit. Corrige a versão da CEF (é a **108**, não "~70"), mostra por que `getUserMedia` falha de verdade, e traz o spike que provou o transporte A→SFU→B contra um `livekit-server` real. A §12 diz o que continua bloqueado: ninguém ouviu. |
| [SKYVOICE_CORE_ETAPA_2.md](technical/SKYVOICE_CORE_ETAPA_2.md) | O Voice Core: quem decide quem ouve quem, o índice espacial que derrubou o tick de 2 s para 150 ms, e o bench que mede isso e sai 1 se a meta não for atingida. A §11 é o checklist de teste humano — é ele que destrava os blockers #1 e #2. |
| [SKYVOICE_CORE_ETAPA_3.md](technical/SKYVOICE_CORE_ETAPA_3.md) | **A voz como gameplay.** A `VoicePolicyEngine` com uma porta só para morto/inconsciente/abatido/amordaçado/silenciado, áudio espacial na CEF 108, oclusão em três níveis (o 2 estudado e o 3 recusado, com motivo), estado de fala e HUD. A §12 lista 17 coisas não testadas — a primeira continua sendo que ninguém ouviu. |
| [VOICE_CLIENT_PATCH.md](technical/VOICE_CLIENT_PATCH.md) | Runbook do patch de client que o VOIP nativo precisava e que não existe upstream — **descartado**, e mantido porque explica por que a captura saiu do navegador. O bloco no topo corrige a versão da CEF e acrescenta o terceiro motivo da rejeição. |
| [VOICE_NATIVE_HELPER.md](technical/VOICE_NATIVE_HELPER.md) | O caminho de voz que **existe e captura hoje**, e o Plano B da migração. WASAPI fora do CEF, relay pelo servidor, primeiro build e primeira captura medida (§8.3, §8.4). A §8.2 diz o que continua sem prova: ninguém ouviu. |
| [VOICE_FORK_AUDIT_SKYMP_VGR_2026-08-11.md](technical/VOICE_FORK_AUDIT_SKYMP_VGR_2026-08-11.md) | O único fork com voz LiveKit ponta a ponta no fonte — e as lacunas dele (`proximityLoop` que não inicia, API de posição aberta sem autenticação) que não devemos repetir. |

### Decisões tomadas

| Documento | Decisão |
|---|---|
| [PARKED_SERVICES_DECISION.md](technical/PARKED_SERVICES_DECISION.md) | Quais serviços estacionados foram apagados e por quê — duas rodadas de avaliação, e o critério que a primeira deixou escapar (§7). |
| [NPC_POLICY_DECISION.md](technical/NPC_POLICY_DECISION.md) | Como lidar com NPCs vanilla num servidor Heavy RP. Deixou seis perguntas abertas na §5. |
| [HOSTILE_MOB_ACTIVATION_DECISION.md](technical/HOSTILE_MOB_ACTIVATION_DECISION.md) | Responde a terceira delas — criaturas hostis ficam ativas —, e derruba a premissa de que havia algo a "ativar": o `npc-cleaner` é inerte, então o mundo provavelmente já está cheio de lobos e ursos. Análise de 15 pontos. **A mecânica continua sem uma linha de código**; os dois instrumentos que a decidem existem desde 08/08 — ver [FAUNA_CENSUS_PROTOCOL.md](technical/FAUNA_CENSUS_PROTOCOL.md). |
| [NAMETAG_IDENTITY_SYSTEM.md](technical/NAMETAG_IDENTITY_SYSTEM.md) | Por que o nome exibido depende de quem está olhando. |
| [MARKET_STALL_VISUAL_ASSET_PLAN.md](technical/MARKET_STALL_VISUAL_ASSET_PLAN.md) | Assets visuais das barracas, com análise de licença mod a mod. |

### Design de mundo

| Documento | Sobre |
|---|---|
| [design/SOUL_AFFINITY.md](design/SOUL_AFFINITY.md) | **Afinidade da Alma — desenho fechado, domínio e serviço implementados.** Unifica magia, vampirismo, licantropia, corrupção, encantamento e linhagem. Parte I: análise de 15 pontos. Parte II: como isso vira jogo bom. Parte III: especificação. |

### Estudos de referência

| Documento | Fonte |
|---|---|
| [REFERENCE_STUDY_SKYMP_RED_HOUSE.md](technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md) | O único gamemode RP público que existe (GPL-3.0, parado em 2021). A §4.1 é leitura do código-fonte. |

### Planejamento

| Documento | Sobre |
|---|---|
| [HEAVY_RP_GAMEPLAY_SYSTEMS_BACKLOG.md](technical/HEAVY_RP_GAMEPLAY_SYSTEMS_BACKLOG.md) | Backlog de sistemas de gameplay. |
| [GUIA_SESSAO_DE_TESTE.md](technical/GUIA_SESSAO_DE_TESTE.md) | **Como chegar até o roteiro:** ligar os quatro serviços, conferir as portas, e o guia copiável para mandar aos testadores. A Parte 2 é escrita para quem nunca viu o repositório. |
| [FASE_0_ROTEIRO.md](technical/FASE_0_ROTEIRO.md) | **O roteiro do teste in-game — o único bloqueio real do projeto.** Passo a passo, o que observar, o que significa falhar, e o registro pra preencher enquanto testa. Comece pelo guia acima. |
| [FAUNA_CENSUS_PROTOCOL.md](technical/FAUNA_CENSUS_PROTOCOL.md) | Sessão separada do roteiro, e de outra natureza: **não há "passou" nem "falhou", só o que existe no mundo.** Como rodar o censo de fauna e a prova do cadáver — as duas perguntas que decidem se a mecânica de caça existe. |
| [MOBS_LOOT_LAB_HANDOFF_2026-08-12.md](roadmap/MOBS_LOOT_LAB_HANDOFF_2026-08-12.md) | Resultado do boot instrumentado: NPCs estavam desabilitados por ausência de `npcEnabled`; configuração local corrigida, sondas carregadas e comandos da sessão in-game registrados. |
| [GOVERNANCE_MARKET_STALLS_TEST_PLAN.md](technical/GOVERNANCE_MARKET_STALLS_TEST_PLAN.md) | Plano em camadas de 13/07, restrito a governança e barracas. Superado pelo roteiro acima. |

### Ciclo de hardening de 11/08/2026

| Documento | Estado |
|---|---|
| [roadmap/CODEX_CLAUDE_IMPLEMENTATION_PLAN.md](roadmap/CODEX_CLAUDE_IMPLEMENTATION_PLAN.md) | Plano coordenado; o snapshot inicial já foi consolidado em `c23179d`. |
| [roadmap/TASK_001_UI_EVENT_CONTRACT.md](roadmap/TASK_001_UI_EVENT_CONTRACT.md) | Gateway, validação e rate limiting de eventos CEF implementados; CEF real pendente. |
| [roadmap/TASK_002_CORE_TYPECHECK.md](roadmap/TASK_002_CORE_TYPECHECK.md) | Estado do typecheck e limites do contrato JS atual. |
| [roadmap/TASK_003_CONNECTION_LIFECYCLE.md](roadmap/TASK_003_CONNECTION_LIFECYCLE.md) | Monitor de conexão implementado; cliente real pendente. |
| [roadmap/TASK_004_ECONOMY_TRANSACTION_BOUNDARY.md](roadmap/TASK_004_ECONOMY_TRANSACTION_BOUNDARY.md) | Tesouros e mercado regional transacionais; módulo regional permanece PARKED. |
| [roadmap/TASK_005_VOIP_CAPACITY_AND_SECURITY.md](roadmap/TASK_005_VOIP_CAPACITY_AND_SECURITY.md) | Limites de protocolo implementados; benchmark de áudio real pendente. |
| [roadmap/TASK_006_MARKET_STALL_IDEMPOTENCY.md](roadmap/TASK_006_MARKET_STALL_IDEMPOTENCY.md) | Retry idempotente implementado; concorrência com dois clientes pendente. |
| [technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md](technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md) | Inventário das identidades, tokens e fronteiras de confiança. |
| [technical/AUTH_002_OPAQUE_TICKET_V1.md](technical/AUTH_002_OPAQUE_TICKET_V1.md) | Contrato de credencial opaca, hashing e redaction. |
| [technical/CHR_001_ACCOUNT_SESSION_CHARACTER_IDENTITY.md](technical/CHR_001_ACCOUNT_SESSION_CHARACTER_IDENTITY.md) | Contrato de identidade entre conta, sessão e personagem. |

### Pesquisa de forks

As duas rodadas cobrem conjuntos **diferentes** de projetos e se somam. A de 12/08 auditou oito forks do SkyMP; a de 13/08 cobriu os sete projetos de referência do briefing de ecossistema, dos quais quatro nunca tinham sido vistos.

| Documento | Sobre |
|---|---|
| [research/SKYMP_FORK_DIFF_MATRIX.md](research/SKYMP_FORK_DIFF_MATRIX.md) | **Rodada de 14/08**, e a primeira feita por comparação de commits em vez de leitura de árvore. Corrige duas afirmações registradas como fato: o "fork do Red House" não tem um commit próprio na `main`, e o Hijos tem o dobro do que estava documentado. |
| [research/SKYMP_ECOSYSTEM_MATRIX.md](research/SKYMP_ECOSYSTEM_MATRIX.md) | **Rodada de 13/08.** Matriz de 37 sistemas contra sete projetos, com licença e profundidade de verificação de cada um — três deles não têm licença, e são justamente os que têm o que nos falta. |
| [research/SKYMP_ECOSYSTEM_DEEP_DIVE.md](research/SKYMP_ECOSYSTEM_DEEP_DIVE.md) | Relatório por projeto. Traz os quatro achados acionáveis, os dois resultados negativos, e onde nós estamos à frente. |
| [roadmap/ECOSYSTEM_ADAPTATION_ROADMAP.md](roadmap/ECOSYSTEM_ADAPTATION_ROADMAP.md) | P0–P7 derivado da rodada de 13/08. Não reordena o roadmap de forks; acrescenta e declara dependência. Cinco tarefas não dependem da Fase 0. |
| [research/SKYMP_FORK_RESEARCH_EXECUTIVE_SUMMARY.md](research/SKYMP_FORK_RESEARCH_EXECUTIVE_SUMMARY.md) | **Rodada de 12/08.** Síntese executiva da pesquisa do ecossistema e lacunas Heavy RP. |
| [research/SKYMP_ECOSYSTEM_SYSTEM_MAP.md](research/SKYMP_ECOSYSTEM_SYSTEM_MAP.md) | Mapa dos sistemas encontrados nos forks estudados. |
| [research/SKYMP_FORKS_SYSTEM_MATRIX.md](research/SKYMP_FORKS_SYSTEM_MATRIX.md) | Matriz comparativa dos forks. |
| [technical/REFERENCE_STUDY_SKYMP_FORKS_2026-08-11.md](technical/REFERENCE_STUDY_SKYMP_FORKS_2026-08-11.md) | Estudo técnico consolidado e rastreável. |

---

## Plataforma: launcher, game-api e distribuição

| Documento | Sobre |
|---|---|
| [research/PLATFORM_INFRASTRUCTURE_AUDIT.md](research/PLATFORM_INFRASTRUCTURE_AUDIT.md) | **Auditoria de 13/08.** O caminho login→fila→sessão auditado linha a linha: 27 achados, o desenho da máquina de estados do launcher, o manifesto v2, e o que fazer (e o que **não** fazer) de infraestrutura antes da Fase 0. |
| [platform/MOD_DISTRIBUTION_POLICY.md](platform/MOD_DISTRIBUTION_POLICY.md) | O que pode ser redistribuído e o que só pode ser verificado. Quatro categorias, e como o manifesto as codifica. |
| [testing/LAUNCHER_PLATFORM_TEST_MATRIX.md](testing/LAUNCHER_PLATFORM_TEST_MATRIX.md) | Instalação limpa, update, repair, manifesto adversário, backend fora do ar, fila, tickets. O que já é coberto, o que só uma máquina com Skyrim prova, e onde investir primeiro. |
| [technical/LAUNCHER_DISTRIBUTION.md](technical/LAUNCHER_DISTRIBUTION.md) | O que o código faz **hoje** — canais, manifestos, login, assinatura do instalador. |

---

## Plataforma administrativa: painel de staff, RBAC e moderação

| Documento | Sobre |
|---|---|
| [research/ADMIN_PLATFORM_AUDIT.md](research/ADMIN_PLATFORM_AUDIT.md) | **Auditoria de 13/08.** O que existe hoje: dois sistemas de permissão que não se conhecem, três permissões que nada verifica, ban construído pela metade, e o teto real do que a API `mp` permite fazer com jogador conectado. |
| [admin/ADMIN_PLATFORM.md](admin/ADMIN_PLATFORM.md) | O painel alvo: catorze módulos, cinco fases, o fluxo de uma ação — e por que `server.restart` e `modules.toggle` a quente ficam de fora. |
| [admin/RBAC.md](admin/RBAC.md) | Catálogo de ~40 permissões, seis cargos, modelo de dados, contrato do middleware e a política de Discord. |
| [admin/MODERATION_WORKFLOW.md](admin/MODERATION_WORKFLOW.md) | Casos, warns, ban com prazo, whitelist em cinco estados, apelação — e a diferença entre aposentar e matar um personagem. |
| [testing/ADMIN_SECURITY_MATRIX.md](testing/ADMIN_SECURITY_MATRIX.md) | O portão: três testes por rota, matriz cargo × permissão, ameaças da §20 e as mutações que provam que os testes valem. **Nenhum deles existe ainda.** |
| [technical/ADR_005_ADMIN_RBAC.md](technical/ADR_005_ADMIN_RBAC.md) | A decisão: permissão é a unidade, cargo é agrupamento, o banco é a autoridade, e não há herança entre cargos. |

---

## Modding

| Documento | Sobre |
|---|---|
| [MODDING_GUIDELINES.md](MODDING_GUIDELINES.md) | Política de mods: regra de ouro, perfis, fases de QA, lista negra. |
| [MODPACK.md](MODPACK.md) | Composição do modpack. |
| [platform/MOD_DISTRIBUTION_POLICY.md](platform/MOD_DISTRIBUTION_POLICY.md) | Permissão de redistribuição, mod a mod. |
| [technical/MODS_AND_GAMEMODE_CONTRACT.md](technical/MODS_AND_GAMEMODE_CONTRACT.md) | O lado técnico da mesma questão. |

---

## Regras de RP e staff

| Documento | Sobre |
|---|---|
| [rules/HEAVY_RP_RULES.md](rules/HEAVY_RP_RULES.md) | Regras de roleplay do servidor. |
| [rules/PUBLIC_RULES_LAUNCH_OUTLINE.md](rules/PUBLIC_RULES_LAUNCH_OUTLINE.md) | Esboço das regras públicas de lançamento. |
| [rules/CHARACTER_APPLICATION_TEMPLATE.md](rules/CHARACTER_APPLICATION_TEMPLATE.md) | Modelo de ficha de personagem. |
| [staff/WHITELIST_RUBRIC.md](staff/WHITELIST_RUBRIC.md) | Critérios de aprovação de whitelist. |

---

## Legal

| Documento | Sobre |
|---|---|
| [legal/ASSET_LICENSE_REGISTRY.md](legal/ASSET_LICENSE_REGISTRY.md) | Registro de licença de cada asset usado. |
| [technical/LICENSE_AND_AFFILIATION_POLICY.md](technical/LICENSE_AND_AFFILIATION_POLICY.md) | Política de licença e não-afiliação. |
| [../LICENSE](../LICENSE) | AGPL-3.0. |

---

## Histórico

| Documento | Sobre |
|---|---|
| [roadmap/PHASE_0_TEST_LOG.md](roadmap/PHASE_0_TEST_LOG.md) | Evidências dos testes da Fase 0 (11/07/2026 — boot de servidor, `offlineMode=true`). |
| [roadmap/FASE_0_LOG_2026-08-06.md](roadmap/FASE_0_LOG_2026-08-06.md) | Registro da execução do [roteiro atual](technical/FASE_0_ROTEIRO.md). Etapa 0 preenchida; o resto aguarda a sessão com dois jogadores. |

---

## Convenções desta documentação

- **Português.** Termos técnicos consagrados ficam em inglês (`whitelist`, `commit`, `hash`).
- **Sobre o idioma:** existem **oito documentos traduzidos** para inglês, russo e espanhol — os três de entrada (`README`, `CONTRIBUTING`, `SECURITY`) e os cinco que barram um dev de fora (ver a tabela abaixo). Russo porque é a língua nativa da comunidade SkyMP (o upstream e o Red House são russos), espanhol pelo alcance na América Latina. Os demais documentos ficam **só em português** de propósito: são regras de RP, pesquisas, handoffs, rubricas de staff, backlog e decisões históricas — servem à operação deste servidor, não a quem chega de fora. Tradução desatualizada é pior que tradução ausente: é um texto em que as pessoas confiam e que mente em silêncio. Se algum documento específico bloquear alguém, traduzimos aquele sob demanda.
- **Mexeu num documento traduzido? Atualize as quatro cópias no mesmo PR.** É a regra que decide se essa tradução vale a pena ou vira dívida. Se não der pra atualizar todas, é melhor apagar as traduções daquele documento do que deixá-las mentindo.
  - **O `README` é a exceção deliberada, e só ele.** As quatro cópias não têm as mesmas seções: a portuguesa carrega o log de status do projeto, e as três traduzidas carregam tabela de componentes, "o que você não acha em outro lugar" e a política de idioma da documentação — porque quem chega em inglês, russo ou espanhol está avaliando o projeto, não acompanhando o dia a dia dele. Isso é adaptação de público, não tradução vencida. O que **não** pode divergir é afirmação: o aviso de que o servidor ainda não foi validado com jogadores reais está nas quatro, e nenhuma diz algo que outra contradiga. Para todos os outros sete documentos da família, seção que existe numa cópia existe nas quatro.
- **Idioma novo entra na linha de troca de TODOS os arquivos da família.** Os quatro arquivos de cada documento (`X.md`, `X.en.md`, `X.ru.md`, `X.es.md`) carregam a mesma linha de links no topo. Um idioma que não seja adicionado nessa linha em todos eles fica invisível.

### Documentos traduzidos

| Documento | Por que este e não outro |
|---|---|
| [`../README.md`](../README.md) · [en](../README.en.md) · [ru](../README.ru.md) · [es](../README.es.md) | Porta de entrada |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) · [en](../CONTRIBUTING.en.md) · [ru](../CONTRIBUTING.ru.md) · [es](../CONTRIBUTING.es.md) | As invariantes que já foram quebradas |
| [`../SECURITY.md`](../SECURITY.md) · [en](../SECURITY.en.md) · [ru](../SECURITY.ru.md) · [es](../SECURITY.es.md) | Ninguém deve errar o canal de reporte por barreira de idioma |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) · [en](ARCHITECTURE.en.md) · [ru](ARCHITECTURE.ru.md) · [es](ARCHITECTURE.es.md) | Sem isso não dá pra entender o que fala com o quê |
| [`technical/QA_REPORT_2026-08.md`](technical/QA_REPORT_2026-08.md) · [en](technical/QA_REPORT_2026-08.en.md) · [ru](technical/QA_REPORT_2026-08.ru.md) · [es](technical/QA_REPORT_2026-08.es.md) | É onde está a verdade sobre o que não está pronto |
| [`technical/MODS_AND_GAMEMODE_CONTRACT.md`](technical/MODS_AND_GAMEMODE_CONTRACT.md) · [en](technical/MODS_AND_GAMEMODE_CONTRACT.en.md) · [ru](technical/MODS_AND_GAMEMODE_CONTRACT.ru.md) · [es](technical/MODS_AND_GAMEMODE_CONTRACT.es.md) | A pergunta mais repetida da comunidade |
| [`technical/SKYMP_UPSTREAM_REFERENCE.md`](technical/SKYMP_UPSTREAM_REFERENCE.md) · [en](technical/SKYMP_UPSTREAM_REFERENCE.en.md) · [ru](technical/SKYMP_UPSTREAM_REFERENCE.ru.md) · [es](technical/SKYMP_UPSTREAM_REFERENCE.es.md) | Útil pra qualquer servidor SkyMP, mesmo quem não usa esta base |
| [`technical/SERVER_OPTIONS_SCHEMA.md`](technical/SERVER_OPTIONS_SCHEMA.md) · [en](technical/SERVER_OPTIONS_SCHEMA.en.md) · [ru](technical/SERVER_OPTIONS_SCHEMA.ru.md) · [es](technical/SERVER_OPTIONS_SCHEMA.es.md) | Separa a opção que funciona da que é só intenção |
- **Diga o que não funciona.** Documento que só descreve o caminho feliz vira mentira com o tempo. Quando algo está incompleto, o texto diz — e vários avisos aqui existem porque a documentação antiga afirmava coisas que o código nunca fez.
- **Marque a procedência.** Ao afirmar algo sobre o SkyMP, diga se veio da documentação oficial, de teste real ou de leitura de código. As três têm confiabilidades diferentes.
- **Ao mudar comportamento, atualize o documento no mesmo PR.** Documentação desatualizada custa mais caro que documentação ausente: ela é confiada.
