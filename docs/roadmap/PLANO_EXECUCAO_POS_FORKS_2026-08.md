# Plano de execução pós-pesquisa de forks

**Status:** ATIVO  
**Início:** 12/08/2026  
**Próxima revisão:** 13/08/2026, quando o Claude estiver disponível  
**Dono da integração:** Codex  
**Aprovação de escopo e reativação de módulos:** responsável pelo projeto  

## 1. Objetivo

Transformar a pesquisa de forks em entregas úteis sem trocar a base do projeto, importar dívidas externas ou reativar serviços `PARKED` antes das provas técnicas necessárias.

Este plano não substitui o `SKYMP_RP_DEVELOPMENT_PLAN.md`. Ele organiza a execução imediata, os pacotes que podem ser delegados ao Claude e os gates que determinam quando cada sistema pode avançar.

## 2. Decisões já tomadas

1. O projeto continua sobre a base atual do SkyMP; nenhum fork será adotado integralmente.
2. Código externo só entra por componente isolado, com origem, autor, licença e commit registrados.
3. Nenhum serviço `PARKED` será registrado no `module-registry` apenas para “experimentar”. Primeiro vem desenho, testes e decisão explícita de reativação.
4. A Fase 0 in-game é o bloqueio principal. Uma suíte mockada verde não substitui dois clientes reais.
5. A ordem funcional permanece:
   - fechar Fase 0;
   - Etapa 2 da Afinidade da Alma e reativação controlada do crafting;
   - identidade e emotes;
   - primeira profissão simples;
   - decisões separadas sobre trade, autenticação avançada e housing.
6. Performance nativa, voz LiveKit, objetos móveis e cavalos não entram no caminho crítico da alfa.

## 3. Responsabilidades

| Papel | Responsabilidade |
|---|---|
| **Codex** | Integração final, alterações no gamemode, testes automatizados, correções da Fase 0, revisão de segurança e atualização do plano |
| **Claude, a partir de 13/08** | Estudos comparativos, threat models, matrizes de abuso, revisão de contratos e protótipos previamente delimitados |
| **Operador/testadores** | Execução do roteiro in-game, dois clientes simultâneos, evidências visuais, logs e reprodução de falhas |
| **Responsável pelo projeto** | Aprovar reativação de módulo, regras econômicas, escopo de personagem e mudanças que afetem o produto |

Claude não bloqueia o trabalho de 12/08. Até ele retornar, Codex e operador avançam baseline, preparação e Fase 0.

## 4. Gates obrigatórios

### G0 — Baseline automatizado

Requisitos:

- `npm test` verde em `skymp/gamemode`;
- `npm run typecheck` sem erro novo do projeto;
- schema versionado enumerado por `npm run check:schema:list`;
- worktree sem alteração acidental;
- flags da sessão conferidas pelo `FASE_0_ROTEIRO.md`.

Se G0 falhar, corrige-se o baseline antes da sessão. Nenhuma feature nova começa.

**Baseline automatizado executado em 12/08/2026:**

- dependências restauradas e `@types/ws` adicionado: 18 pacotes auditados, 0 vulnerabilidades reportadas;
- `npm test`: **512/512 testes aprovados**;
- `npm run check:schema:list`: **56 tabelas** enumeradas;
- `npm run typecheck`: **aprovado**, com 0 erros no código ativo e 0 em dependências;
- `npm run typecheck:all`: preserva 3 erros no `economy-regional.js` estacionado (`getMembership` não exportado e dois usos de `factionInfo` inexistente);
- política e dívida registradas em `docs/technical/TYPECHECK_POLICY.md`;
- preflight da Fase 0 implementado e coberto por 8 testes: `docs/technical/PHASE_0_PREFLIGHT.md`;
- perfil `main/local` executado: 9 verificações aprovadas e 9 bloqueios de ambiente identificados.

`CX-00`, `CX-00A` e a ferramenta de `CX-01` foram concluídos. A automação de G0 está verde, mas o ambiente permanece bloqueado pelos `.env`, artifact do servidor, configurações locais e manifesto do modpack listados em `PHASE_0_PREFLIGHT.md`.

A restauração das dependências também revelou dívida de segurança no bot e no launcher. `CX-SEC-01` aplicou correções compatíveis e reduziu ambos a 0 vulnerabilidades reportadas; detalhes e verificações estão em `docs/technical/DEPENDENCY_AUDIT_2026-08-12.md`.

### G1 — Fase 0 in-game fechada

Requisitos mínimos:

- dois clientes simultâneos se enxergam e sincronizam movimento;
- mudança de célula testada;
- inventário e equipamento testados;
- morte, `DOWNED`, socorro/bleed-out e respawn controlado testados;
- persistência repetida depois de inventário/equipamento e restart;
- chat por proximidade e célula validado visualmente;
- identidade conhecida/apelido sobrevive a reconnect e restart;
- nametag e `/revelaridentidade` validados e auditados;
- `hit-events` e `espm` confirmados por jogador real;
- carregamento de `safe-zones` e `soul-service` registrado nos boots próprios;
- falhas P0/P1 reproduzidas ou resolvidas no log da sessão.

A voz nativa é opcional para fechar G1. O fallback deve ser documentado; LiveKit/helper permanece pós-alfa se não houver ambiente para validá-lo.

Saída obrigatória: atualização de `docs/roadmap/PHASE_0_TEST_LOG.md` ou novo registro no formato definido por `docs/technical/FASE_0_ROTEIRO.md`.

### G2 — Crafting e Afinidade da Alma seguros

Requisitos:

- decisão explícita de retirar `crafting-service` de `PARKED`;
- ingredientes consumidos e resultado criado na mesma transação;
- ledger completo de entrada e saída de itens;
- quatro resultados do encantamento cobertos por testes determinísticos;
- nenhuma afinidade ou valor secreto exposto ao cliente;
- rollback e correção administrativa documentados;
- teste de reconnect/restart depois de encantar.

### G3 — Identidade e emotes prontos para alfa

Requisitos:

- lista curada de animações compatíveis com o modpack;
- autorização server-side antes de tocar um emote;
- `action-policy` bloqueia emote em estados incompatíveis;
- sem nome real vazando para observador que ainda vê `Desconhecido`;
- spam/rate limit e cancelamento cobertos;
- teste com dois clientes.

### G4 — Primeira profissão simples pronta

Requisitos:

- profissão escolhida: minerador por padrão, salvo decisão contrária;
- ferramenta, distância, local, cooldown e estado validados pelo servidor;
- recurso concedido por transação e ledger de inventário;
- tabela de nós/recursos configurável, sem valores hard-coded no handler;
- geração aleatória reproduzível ou registrada para auditoria;
- proteção contra reconnect, corrida, spam e coleta dupla;
- teste com dois clientes e restart.

## 5. Execução por janela

### Janela A — Agora, 12/08, sem depender do Claude

| ID | Responsável | Trabalho | Saída | Bloqueia feature? |
|---|---|---|---|---|
| `CX-00` | Codex | **CONCLUÍDO 12/08:** baseline e gate de typecheck do código ativo | 512 testes, typecheck ativo e schema verdes | Sim |
| `CX-00A` | Codex | **CONCLUÍDO 12/08:** separar ativo, dependência e PARKED sem mascarar dívida | `TYPECHECK_POLICY.md` + testes do classificador | Sim |
| `CX-01` | Codex | **FERRAMENTA CONCLUÍDA 12/08:** preflight por perfil/topologia; ambiente ainda incompleto | 8 testes; 9 bloqueios locais enumerados | Sim |
| `CX-SEC-01` | Codex | **CONCLUÍDO 12/08:** corrigir dependências vulneráveis sem `--force` | Bot e launcher com audit, testes e checks verdes | Não; resta build/smoke do artifact |
| `OP-01` | Operador | Reservar servidor, dois clientes gráficos e três participantes para governança/mercado | Janela de teste marcada | Sim |
| `OP-02` | Operador | Copiar o template de registro da Fase 0 antes da sessão | Registro vazio pronto para preenchimento | Sim |
| `CX-02` | Codex | Manter a pesquisa de forks como watchlist, sem importar código | Lista priorizada e links de origem | Não |

Regra desta janela: não iniciar soul etapa 2, emotes, minerador ou trade enquanto G1 estiver aberto.

### Janela B — Quinta-feira, 13/08, com Claude disponível

Estes pacotes podem começar em paralelo à organização da sessão porque são de análise. Eles não autorizam reativação nem merge de fork.

#### `CL-01` — Proveniência e licença dos componentes candidatos

**Fontes:** SkyrimRoleplay, FusRoBra, SkyV, reggiedroid, Metadraconis, theZebco, DonAthelion e Red House.

**Função do Claude:**

- registrar repositório, branch, commit, arquivo, autor e licença de cada componente potencial;
- separar “ideia”, “contrato”, “UI”, “código de gamemode” e “alteração nativa”;
- marcar incompatibilidades GPL/AGPL, arquivos sem proveniência e relicenciamentos suspeitos;
- recomendar `PORTAR`, `REESCREVER`, `SOMENTE REFERÊNCIA` ou `REJEITAR`.

**Saída:** `docs/technical/FORK_COMPONENT_PROVENANCE.md`.

**Proibições:** não copiar arquivos, não alterar licença e não fazer cherry-pick.

#### `CL-02` — Trade V2: estado, fraude e atomicidade

**Fontes:** `SkyrimRoleplay/skyrp` e janela histórica do Red House.

**Função do Claude:**

- comparar o fluxo externo com `trade-service.js` e `core/transaction-service.js`;
- desenhar estados `REQUESTED`, `OPEN`, `LOCKED`, `COMMITTING`, `COMPLETED`, `CANCELLED`, `EXPIRED`;
- listar ataques: troca de inventário durante aceite, desconexão, distância, duplo clique, replay e falha parcial;
- definir contrato de commit duplo usando uma única transação de banco;
- definir os eventos mínimos de UI, sem portar o frontend inteiro.

**Saída:** `docs/design/TRADE_V2.md` com matriz de abuso e critérios de teste.

**Gate:** somente desenho. Implementação continua bloqueada até inventário e persistência passarem G1 e existir aprovação de escopo.

#### `CL-03` — Blueprint da profissão Minerador

**Fontes:** plano do FusRoBra e `jobs-service.js` local.

**Função do Claude:**

- transformar o plano externo num contrato local server-authoritative;
- mapear o que pode reaproveitar de `jobs-service`, `action-policy`, `espm` e `transaction-service`;
- propor schema/config de nós de mineração, ferramentas, cooldown e recompensas;
- criar matriz de testes e abuso;
- identificar toda escrita de inventário que precise permanecer atômica.

**Saída:** `docs/design/MINER_PROFESSION_MVP.md`.

**Gate:** desenho pode ser feito antes de G1; implementação só começa depois de G3 ou mediante mudança explícita da ordem.

#### `CL-04` — Threat model de autenticação por ticket

**Fonte:** SkyV.

**Função do Claude:**

- avaliar ticket Ed25519, `iss`, `aud`, `exp`, `iat`, `jti` e slots;
- substituir cache de replay somente em memória por desenho persistente/Redis;
- separar autenticação, whitelist, seleção de personagem e spawn;
- mapear integração possível com launcher e master API atuais.

**Saída:** `docs/design/LAUNCHER_JOIN_TICKET.md`.

**Prioridade:** baixa até o launcher e a whitelist virarem o próximo gargalo real.

#### `CL-05` — Revisão independente do plano

**Função do Claude:** procurar dependências circulares, gates impossíveis, escopo escondido e tarefas que duplicam algo já implementado.

**Saída:** comentários no próprio plano ou `docs/roadmap/PLANO_EXECUCAO_POS_FORKS_2026-08_REVIEW.md`.

### Janela C — Primeira sessão real e estabilização

1. Executar etapas 0–7 do `FASE_0_ROTEIRO.md`.
2. Executar 9.1 e 9.2 na mesma janela contínua.
3. Executar 9.3 e 9.4 em boots separados.
4. Executar voz apenas se o ambiente estiver pronto; não atrasar G1 por LiveKit.
5. Classificar falhas:
   - **P0:** corrupção, duplicação, perda de patrimônio, bypass de staff ou crash recorrente;
   - **P1:** sistema central não funciona com dois clientes;
   - **P2:** comportamento incorreto com contorno seguro;
   - **P3:** visual, texto ou ergonomia.
6. Codex corrige P0/P1, adiciona teste de regressão e solicita repetição do passo exato.
7. G1 fecha somente após o registro conter resultado, evidência e decisão.

### Janela D — Afinidade da Alma e crafting

| Ordem | ID | Responsável | Trabalho |
|---|---|---|---|
| 1 | `CX-10` | Codex | Preparar decisão formal de reativação do crafting e contrato transacional |
| 2 | `CL-10` | Claude | Revisar atomicidade, economia, fraude e casos de falha antes da implementação |
| 3 | `CX-11` | Codex | Implementar os quatro resultados de encantamento e primeiras marcas |
| 4 | `CX-12` | Codex | Adicionar testes, migrations/config e integração mínima de UI/comando |
| 5 | `OP-10` | Operador | Testar encantamento, reconnect e restart em staging |

Somente depois dessa janela aprovada o `crafting-service` pode ser registrado.

### Janela E — Identidade, emotes e primeira profissão

1. Implementar emotes autorizados pelo servidor e testar G3.
2. Revisar e aprovar o blueprint `CL-03`.
3. Reativar somente o caminho de mineração necessário dentro de `jobs-service`.
4. Não reativar madeireiro e pesca no mesmo pacote.
5. Rodar G4 e observar geração de recursos antes de criar mercado adicional.

### Janela F — Decisões posteriores, uma por vez

| Sistema | Fonte externa útil | Pré-condição para voltar à pauta |
|---|---|---|
| Trade | SkyrimRoleplay + Red House | Inventário/persistência aprovados, `TRADE_V2.md` aceito e commit duplo desenhado |
| Autenticação/slots | SkyV | Launcher/whitelist se tornarem o gargalo do onboarding |
| Housing | SkyrimRoleplay + FusRoBra | Política de propriedade, acesso e storage aprovada; teste contra duplicação |
| Performance | reggiedroid | Telemetria real mostrar custo de relay/tick; benchmark repetido em nosso hardware |
| Voz LiveKit | Metadraconis/theZebco | Voz virar requisito da alfa e existir capacidade para manter client C++ + infraestrutura |
| Objetos móveis | theZebco | Housing/decor aprovado e CI restaurado para falhar em teste quebrado |
| Cavalos | DonAthelion | Sincronização básica estável, housing/economia resolvidos e escopo reaberto |

## 6. Contrato de entrega do Claude

Todo pacote entregue pelo Claude deve conter:

1. arquivos lidos e arquivos alterados;
2. hipóteses e fatos separados;
3. origem exata de código ou ideia externa;
4. riscos de segurança, economia e persistência;
5. testes executados e testes ainda impossíveis;
6. plano de rollback;
7. recomendação explícita: integrar, adaptar, estacionar ou rejeitar.

Regras adicionais:

- não fazer merge ou cherry-pick de fork inteiro;
- não registrar módulo `PARKED` sem aprovação;
- não alterar `phase0-basic.js` para ativar feature como parte de uma revisão;
- não enfraquecer CI, ignorar falhas ou usar `exit 0` em testes;
- não substituir `transaction-service` por rollback manual;
- não criar uma segunda fonte de verdade para identidade, facção, ouro ou inventário;
- deixar handoff curto para Codex integrar e verificar.

## 7. Quadro de acompanhamento

| Gate/entrega | Estado inicial | Próxima ação |
|---|---|---|
| G0 — baseline | FERRAMENTAS VERDES: 512 testes, typecheck ativo, schema enumerado e preflight testado | Operador fornece configurações, artifact e modpack; repetir o preflight até 0 erros |
| G1 — Fase 0 in-game | ABERTO | Marcar sessão com dois clientes e três participantes |
| `CX-SEC-01` dependências | CONCLUÍDO: 0 vulnerabilidades no bot e launcher | Repetir audit no próximo build distribuível |
| `CL-01` proveniência | AGUARDA CLAUDE | Iniciar em 13/08 |
| `CL-02` Trade V2 | AGUARDA CLAUDE | Iniciar em 13/08, desenho apenas |
| `CL-03` Minerador | AGUARDA CLAUDE | Iniciar em 13/08, desenho apenas |
| `CL-04` ticket | BACKLOG BAIXO | Só iniciar se houver capacidade |
| G2 — soul/crafting | BLOQUEADO POR G1 | Decidir reativação após sessão |
| G3 — emotes | BLOQUEADO POR G1 | Curar lista e contrato após sessão |
| G4 — minerador | BLOQUEADO POR G3 | Aprovar blueprint e implementar um caminho |
| Trade/housing/voz/cavalos | PARKED | Não executar no caminho crítico |

## 8. Definição de sucesso desta rodada

A rodada é bem-sucedida quando:

- G0 está verde;
- existe data e ambiente para a sessão real;
- G1 possui registro completo, mesmo que revele falhas;
- Claude entrega pelo menos `CL-01`, `CL-02` e `CL-03` sem importar código prematuramente;
- a próxima implementação é escolhida por gate, não por quantidade de código disponível em um fork;
- nenhum sistema estacionado entra em produção por acidente.
