# SkyMP Heavy RP — Control Panel

**Status:** desenho aceito, implementação não iniciada
**Evidência:** [`ADMIN_PLATFORM_AUDIT.md`](../research/ADMIN_PLATFORM_AUDIT.md)
**Permissões:** [`RBAC.md`](RBAC.md) · **Moderação:** [`MODERATION_WORKFLOW.md`](MODERATION_WORKFLOW.md)
**Relação com `docs/skyadmin/`:** aquele diretório é o plano anterior e continua
válido como intenção. Este documento é o recorte que a auditoria confirmou ser
construível, e onde os dois divergirem, este ganha (ver auditoria §7).

---

## 1. O que estamos construindo, e o que não

O alvo é o equivalente conceitual de um **txAdmin + painel de staff Heavy RP**,
nativo desta arquitetura. Não é um port: metade do que o txAdmin faz depende de
um console de servidor que o SkyMP não tem.

**Não é:**

- um cliente de SQL com interface bonita — nenhuma tela edita tabela direto;
- um terminal remoto — nenhuma rota executa shell;
- um segundo produto — evolui dentro de `apps/web`, decisão SA-001 do skyadmin.

---

## 2. Módulos e o que os destrava

Ordem da barra lateral. A coluna **Bloqueio** é a única que importa para
planejar: ela diz o que precisa existir antes.

| Módulo | Conteúdo | Bloqueio |
|---|---|---|
| **Dashboard** | contadores, fila de whitelist, últimas ações, saúde dos serviços | — parcialmente pronto |
| **Players** | contas, perfil, histórico de sessões, moderação | RBAC |
| **Characters** | ficha, inventário, patrimônio, notas, aposentadoria | RBAC |
| **Moderation** | casos, warns, bans, apelações | RBAC + tabelas de caso e ban |
| **Whitelist** | fila com 5 estados, parecer, revisor | RBAC (o resto existe) |
| **Staff** | equipe, cargos, permissões, concessão temporária | RBAC |
| **Economy** | razão, busca de transação, ajuste, congelamento | RBAC |
| **Factions** | facções, membros, tesouro | RBAC |
| **Properties** | propriedades e hóspedes | RBAC |
| **World** | censo de fauna, sonda de cadáver, zonas seguras | RBAC + **ponte de jogo** |
| **Server** | manutenção, anúncio, capacidade, fila | RBAC + **ponte de jogo** |
| **Modules** | estado dos módulos do registry | RBAC + **ponte de jogo** |
| **Logs** | auditoria com filtro; aba de segurança separada | RBAC + `audit_events` ✅ |
| **Developer** | health, versões, manifesto, drift de schema, crash reports | RBAC |

Três módulos — World, Server, Modules — dependem de uma peça que **não existe**:
um canal entre o painel e o processo do servidor de jogo. Ver §5.

---

## 3. Fases

Cada fase é entregável sozinha. Nenhuma depende de sessão em jogo, exceto a 4.

| Fase | Entrega | Fecha |
|---|---|---|
| **1 — Fundação** | migration de RBAC, `requirePermission` em todas as rotas, auditoria de negação, sessão em MariaDB, CSRF, helmet/CSP | achados 4.1, 4.3, 4.5, 4.6, 4.9, 4.10 |
| **2 — Operação de leitura** | Players, Characters, Whitelist com 5 estados, Logs com filtro, Staff | dá à staff um painel utilizável sem nenhuma ação de risco |
| **3 — Moderação persistente** | casos, warns, ban com motivo/prazo/revogação de sessão, Economy admin, Inventory admin | achados 4.2, 4.4, 4.7 |
| **4 — Ponte de jogo** | sessões ao vivo, kick pelo painel, anúncio, manutenção | achado 4.8 — exige protocolo novo **e** uma sessão real |
| **5 — Adiado** | World tools, Reports, Modules toggle | depende da 4 e de demanda observada |

A fase 1 não entrega tela nova. É deliberado: hoje qualquer pessoa em
`staff_roles` lê a ficha criminal e o Discord ID de todo mundo, e construir tela
antes de fechar isso aumenta a superfície do problema.

---

## 4. Fluxo de uma ação

```
Navegador
  └─► Admin API (apps/web)
        ├─ 1. sessão            → 401 se ausente
        ├─ 2. RBAC              → 403 se faltar permissão  → AUDITA a negação
        ├─ 3. validação         → 400; rejeita campo desconhecido
        ├─ 4. idempotência      → repetição devolve o mesmo resultado
        └─► Service (transação única)
              ├─ muta o domínio
              ├─ grava audit_events (antes/depois, permissão, correlationId)
              └─ enfileira efeito externo, quando houver
                    └─► Servidor de jogo, via canal autenticado   [FASE 4]
```

Regras que atravessam todas as fases:

1. **A UI nunca fala com o banco.** Nem para leitura.
2. **Mutação de domínio e linha de auditoria são a mesma transação.** Auditoria
   que pode falhar sozinha não é auditoria.
3. **Dinheiro e item passam pelos serviços que já existem** — `transaction-service`
   e nada mais. O painel é só mais um chamador.
4. **Toda ação 🟡/🔴 exige `reason` não vazio**, validado no servidor.
5. **Chave de idempotência por tentativa do usuário.** Duplo clique não gera dois
   bans, e nenhum `retry` de rede gera dois ajustes de ouro.

---

## 5. Ações em jogador conectado — o teto real

A auditoria §4.8 mediu o que a API `mp` oferece. O resumo que decide o escopo:

| Ação | Viável? | Como |
|---|---|---|
| **kick** | ✅ | `mp.kick` já é usado por `admin-service` e pelo `connection-monitor` |
| **teleport** | ✅ | `mp.set(actorId, 'locationalData')`, já usado |
| **announce** | ✅ | `commands.sendNotification` em varredura |
| **ban de conta offline** | ✅ | escrita no banco; enforcement já existe em dois pontos |
| **ban de conta online** | ⚠️ | precisa de kick — logo, precisa da ponte |
| **warn** | ⚠️ | persiste hoje; entrega in-game precisa da ponte |
| **freeze** | ❌ | não existe; exigiria Papyrus + observação em sessão real |
| **spectate** | ❌ | não existe |
| **mute** | ❌ | não existe; o `voip-service` teria de expor um corte por ator |
| **ping** | ❌ | **a API `mp` não expõe latência.** Não haverá coluna de ping |

O painel **não vai listar ação que não funciona**. Um botão cinza com "em breve"
é melhor que um botão que responde `ok` sem efeito — e a auditoria encontrou uma
permissão (`ban`) que existe há meses exatamente nesse estado.

### 5.1 Painel de sessões ativas

Dados por sessão, e apenas estes:

| Campo | Origem | Disponível? |
|---|---|---|
| conta | `game_sessions.account_id` | ✅ |
| personagem | `commands.getActiveCharacterData(actorId)` | só dentro do gamemode |
| Discord | `discord_identities` | ✅ |
| `connectedAt` | fila do `game-api` (`markConnected`) | ✅ em memória |
| célula | `mp.get(actorId, 'locationalData').cellOrWorldDesc` | só dentro do gamemode |
| estado do personagem | `core/character-state` | só dentro do gamemode |
| ping | — | ❌ não existe |

**Fora do painel, deliberadamente:** IP, `actorId` bruto para cargo sem
`players.session.view`, e qualquer identidade de personagem que o sistema de
anonimato protege. Revelar nome real continua sendo `identity.reveal`, um ato
auditado — uma lista de sessões que mostrasse nome real de graça contornaria
aquele controle por fora, que é o defeito que o `admin-service.js` gastou trinta
linhas evitando por dentro.

**Sem polling agressivo.** O gamemode já paga polling de 2 s para descobrir
conexão. O painel recebe um instantâneo empurrado em intervalo fixo, ou consulta
sob demanda quando a aba está aberta. O painel nunca vira uma segunda carga sobre
o loop do servidor.

### 5.2 O canal, quando existir

Desenho recomendado, herdado da decisão SA-007 do skyadmin e dos padrões de
GameAP/Wings: **o processo do jogo abre a conexão de saída** para o painel,
autenticado, e recebe apenas comandos de um catálogo fechado. O painel nunca
abre porta no host do jogo.

Motivos: o host é Windows, muitas vezes atrás de NAT; uma porta de comando
exposta no servidor de jogo é a pior superfície possível; e um catálogo fechado
impede que "payload virou comando" seja sequer expressável.

Isso ainda **não está desenhado em detalhe** — protocolo, autenticação,
reconexão e confirmação de execução são trabalho de uma sessão própria, e ela só
faz sentido depois que a Fase 0 tiver tido uma sessão real com jogador conectado.

---

## 6. Controle de servidor e feature flags

### 6.1 O que dá para fazer com segurança

| Capacidade | Como funciona hoje | Painel pode? |
|---|---|---|
| Capacidade / fila | `QUEUE_CAPACITY` no `.env` do `game-api`, lido no boot | leitura sim; escrita exige endpoint interno novo |
| Modo manutenção | não existe | construível: uma flag que a fila consulta antes de admitir |
| Anúncio | não existe | construível na Fase 4 |
| Estado dos módulos | `ENABLE_*` no `.env`, lido no **carregamento** do gamemode | leitura sim; **toggle a quente não** |
| Opções de gameplay | `server-options.<env>.json`, validado no boot | leitura sim; escrita a quente não |
| **Restart do processo** | `launch_server.bat` na mão | **não** |

**`server.restart` não entra.** Não existe supervisor, não existe drenagem de
jogadores, não existe rollback se o processo não voltar. Um botão que derruba o
servidor sem nada disso é a definição de ação irreversível sem aviso, que a
`CONSTITUICAO.md` §5 proíbe. O gatilho para reabrir é infraestrutura: supervisor
que garanta que o processo volta, drenagem com aviso, e um teste de restauração
ensaiado em staging.

**`modules.toggle` a quente não entra agora.** `core/module-registry` decide
ligar/desligar por `process.env` no carregamento, e `server-options.js` valida no
boot e aborta em valor inválido — de propósito. Alternar um módulo em jogo
significaria `shutdown()` no meio de uma sessão com jogadores dentro, e nenhum
módulo foi escrito assumindo isso. O painel **exibe** o estado; mudar continua
sendo `.env` + restart planejado.

### 6.2 Flags: allowlist, nunca ambiente arbitrário

Se e quando o painel escrever configuração, vale a regra que o
`core/server-options.js` já aplica ao arquivo de opções:

1. **Allowlist explícita.** Só entra flag que está numa lista no código, com tipo,
   intervalo e quem a consome. Não existe "editar variável de ambiente".
2. **Só entra o que faz alguma coisa.** `server-options.js` mantém
   `DECLARED_BUT_UNWIRED` com 18 opções justamente porque configuração que
   *parece* existir e não faz nada é pior que configuração ausente. O painel herda
   essa disciplina: flag sem consumidor aparece marcada como inerte, ou não aparece.
3. **Mudança de flag é ação auditada**, com antes/depois, como qualquer outra.
4. **Nada que seja segredo.** `INTERNAL_API_SECRET`, `SESSION_SECRET`,
   `MASTER_KEY`, credencial de banco e token do Discord nunca são legíveis nem
   editáveis pelo painel, em nenhum cargo.

---

## 7. Risco e UI

Três níveis, com tratamento visual distinto — 🟢 leitura, 🟡 muta estado
recuperável, 🔴 irreversível ou de alto impacto. O nível vem de
`staff_permission_catalog.risk`, o mesmo dado que o RBAC usa, para que UI e
autorização não possam discordar.

Ação 🔴 — **ban, permakill, ajuste de ouro, remoção de item, congelamento de
conta, revelação de identidade, mudança de cargo** — exige, sem exceção:

1. cor e posição distintas das ações comuns; nunca adjacente a um botão 🟢;
2. diálogo que **nomeia o alvo** e descreve a consequência em uma frase
   ("Este personagem não poderá mais entrar no servidor");
3. campo de motivo obrigatório, mínimo real, validado no servidor também;
4. quando houver desfazer, dizer qual é; quando não houver, dizer que não há.

Prioridades da interface, na ordem: **clareza · velocidade · poucos cliques ·
risco explícito**. Onde os dois últimos brigarem, risco ganha — um clique a mais
antes de um permakill é o clique mais barato do sistema.

---

## 8. Fila de reports — preparação, não construção

`player report`, `bug report`, `RP report` e `staff ticket` compartilham forma:
alguém abre, alguém triagem, alguém resolve, tudo fica registrado. É o mesmo
formato dos casos de moderação ([`MODERATION_WORKFLOW.md`](MODERATION_WORKFLOW.md) §2).

**Não construir agora.** Uma fila de denúncia sem staff para atendê-la é pior que
não ter fila: cria expectativa de resposta que ninguém cumpre. O gatilho é
operacional, não técnico — quando existir staff em escala e denúncia chegando
por Discord de forma que não caiba mais, a fila nasce reutilizando o modelo de
caso, e a integração com Discord vem depois disso, nunca antes.

Registrado aqui para que quem construir os casos deixe o modelo capaz de receber
`source` (`staff`, `player_report`, `bug`) sem migration nova.

---

## 9. World tools — o limite que já é conhecido

`fauna-census` e `corpse-probe` existem e são autorizados por `world.probe`. Eles
são instrumentos de **observação sob demanda**, e continuam assim.

O que o painel **não** vai fazer: transmitir NPCs continuamente. O gamemode já
documenta que chamada Papyrus é cara (`CONTRIBUTING.md` §3.8) e que
`safe-zones.js` consulta posição sob demanda em vez de assinar eventos de célula
justamente por custo. Um mapa ao vivo de todos os atores inverteria essa decisão
e faria o painel virar carga sobre o loop do jogo — pelo benefício de uma tela
que ninguém pediu.

Inspeção de entidade, censo de NPC, diagnóstico de cadáver, zonas seguras e
posição de jogador entram como **consulta pontual, autorizada e auditada**,
depois da ponte da §5.2.
