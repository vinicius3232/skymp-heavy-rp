# Guia da sessão de teste — ligar o servidor e receber os testadores

Como sair de um repositório parado até três pessoas conectadas no mundo.

> **Este documento não substitui o [`FASE_0_ROTEIRO.md`](FASE_0_ROTEIRO.md).** O roteiro é o que vocês **fazem** depois que todo mundo entrou — passo a passo, o que observar, o que significa falhar. Este guia é como **chegar até lá**: ligar os serviços e colocar as pessoas dentro. Os dois se encaixam nesta ordem, e a Parte 1 aqui é a Etapa 0 do roteiro contada por inteiro, com o que ela pressupõe.

**Quem opera:** 1 pessoa com o repositório, o banco e o servidor.
**Quem testa:** 2 pessoas (A e B) com Skyrim SE/AE. Uma terceira (C) só na Etapa 6 do roteiro.
**Tempo:** ~40 min de preparação sozinho, ~60 min de sessão se nada quebrar.

---

## Antes de tudo: o estado real

Ninguém nunca conectou neste servidor. Não é modéstia — é a razão de a Fase 0 existir, e muda como você lê este guia:

- **Nenhum instalador do launcher jamais foi gerado** ([`LAUNCHER_DISTRIBUTION.md`](LAUNCHER_DISTRIBUTION.md) §6). Não existe link para mandar aos testadores. A Parte 1.5 abaixo trata das duas saídas reais.
- **A cadeia launcher → paridade → fila → sessão → spawn nunca rodou inteira.** É a Etapa 1 do roteiro e a mais provável de quebrar.
- **Falar por voz não vai funcionar, e isso é esperado.** Ver Parte 2, "O que não é bug".

Se algo falhar na preparação, **pare e anote**. O objetivo da sessão é descobrir o que quebra, então uma falha às 22h de sexta é resultado, não fracasso.

---

# Parte 1 — Operador

## 1.0 Decida a topologia primeiro

Isso muda endereço, `.env` e firewall. Escolha antes de configurar qualquer coisa:

| Topologia | Quando usar | O que muda |
|---|---|---|
| **Mesma máquina** | Ensaio solo, dois atores | Tudo em `127.0.0.1`. Não prova rede. |
| **LAN** | Todos na mesma casa/escritório | Use o IP local do servidor (`ipconfig`). O mais simples que ainda prova rede. |
| **Internet** | Testadores remotos — o caso realista | Precisa de IP público ou túnel, e as portas abertas. Ver 1.4. |

⚠️ **Em LAN ou internet, `127.0.0.1` não serve em lugar nenhum da configuração dos testadores.** É o erro mais fácil de cometer aqui: funciona na sua máquina e falha em todas as outras, com a mensagem errada ("servidor offline").

## 1.1 Pré-voo — 10 min, sozinho

Comece pelo verificador somente leitura, escolhendo o perfil e a topologia reais da sessão:

```bash
cd skymp/gamemode
npm run preflight:phase0 -- --profile main --topology local
```

Troque `local` por `lan` ou `internet` quando necessário. O comando lista todas as pendências sem iniciar processos nem mostrar segredos. Os outros perfis e limites do verificador estão em [`PHASE_0_PREFLIGHT.md`](PHASE_0_PREFLIGHT.md).

Depois rode os gates abaixo. Cada um responde uma pergunta diferente, e o schema é o que mais custa se você pular.

```bash
cd skymp/gamemode && npm test
```

Espere **0 falhas** (baseline de 12/08/2026: **512 testes**). Se não passar, não continue — você estaria testando em jogo um código que já sabe estar quebrado.

```bash
cd skymp/gamemode && npm run test:systems
```

Espere **13/13**.

```bash
cd skymp/gamemode && npm run check:schema
```

Espere `[OK] banco e migrations estao alinhados`. Se faltar tabela ou coluna, **aplique as migrations pendentes (`v2`→`v10`, em ordem — são idempotentes)**. Banco meio-migrado não quebra o boot: o servidor sobe, o login passa, e só a query que toca a coluna faltante falha — no meio de uma cena, com ouro envolvido. Foi exatamente assim que a `v9` nasceu.

```bash
ls apps/game-api/mods.json
```

Tem de existir e conter `mods` e `loadOrder`. **Sem ele, `/mods.json` responde 503 e ninguém entra** — nem você. Se faltar:

```bash
cd apps/game-api && node scripts/generate-mods-manifest.js "<pasta Data do servidor>" --plugins-txt "<plugins.txt>"
```

O `--plugins-txt` importa: sem ele o script infere a load order pela ordem alfabética do diretório, que **não** é a load order real do Skyrim.

## 1.2 Configuração

**Flags no `skymp/gamemode/.env`:**

```
ENABLE_GOVERNANCE_SERVICE=true
ENABLE_MARKET_STALLS_SERVICE=true
ENABLE_DEATH_SERVICE=true
ENABLE_PLAYER_PANEL_SERVICE=true
ENABLE_VOIP_SERVICE=false
```

Deixe o VOIP desligado nesta primeira sessão. Ele é a Etapa 8 do roteiro, é opcional e Pós-Alfa, e ligá-lo agora só adiciona uma variável a um teste que já tem muitas.

⚠️ **`offlineMode: false` no `server-settings.json`.** Com `true`, o cliente declara a própria identidade e o servidor acredita — a Etapa 1.6 do roteiro passaria sem provar nada, que é o passo mais importante de todo o teste.

**`.env` obrigatórios**, ou o serviço morre num `require()` dentro de uma janela que ninguém está olhando: `apps/web`, `apps/bot-discord`, `apps/game-api` e `skymp/gamemode`. Cada um tem seu `.env.example` ao lado.

## 1.3 Ligar — um comando

```powershell
.\scripts\phase0\Start-AllServices.ps1
```

Ele confere **antes** de despachar qualquer processo: arquivo de entrada, `.env`, `node_modules`, o `mods.json` e o alinhamento do banco. Depois sobe, em janelas separadas: Painel Web → Bot do Discord → API do Jogo → Servidor SkyMP.

**Leia a saída.** Ele não mente por otimismo: prefere dizer "Orquestracao concluida PARCIALMENTE" a reportar sucesso com um processo morto. Qualquer linha vermelha é um serviço que **não** subiu, e cada um deles é um jeito diferente de o testador ver "servidor offline".

## 1.4 Confirme que está no ar

Quatro portas, quatro propósitos. Confira as quatro antes de chamar alguém — descobrir uma porta fechada com três pessoas esperando é o desperdício mais comum deste tipo de sessão.

| Porta | Serviço | Se estiver fechada |
|---|---|---|
| **7777** | Servidor SkyMP | O jogo não conecta |
| **7758** | API do jogo | Paridade de mods e fila falham — ninguém passa da verificação |
| **3001** | Painel web | Login com Discord e master API de sessão falham |
| 7778 | VOIP | Só importa se você ligou a Etapa 8 |

Em internet, as três primeiras precisam estar **alcançáveis de fora**, não só abertas localmente. Isso nunca foi exercitado neste projeto — se for sua topologia, reserve tempo para ela e trate como parte do teste.

## 1.5 Como os testadores vão entrar

Como **não existe instalador gerado**, há dois caminhos reais. Escolha um e mande só ele — oferecer os dois a quem não é dev garante que a pessoa escolha errado.

**Caminho A — você gera o instalador (recomendado para quem não é dev).**

```bash
cd apps/launcher && npm run build
```

Antes de rodar, preencha `apps/launcher/.env` com o **endereço que o testador alcança**, não o seu `127.0.0.1`: `VITE_SERVER_IP`, `VITE_SERVER_PORT`, `VITE_API_PORT`, `VITE_PANEL_URL`, `VITE_DISCORD_CLIENT_ID`.

⚠️ **Tudo que é `VITE_*` é embutido em tempo de build.** Errou o IP, o instalador inteiro está errado e você refaz. Não dá para o testador corrigir do lado dele.

O instalador sai **não assinado** — o SmartScreen vai bloquear, e o testador precisa de "Mais informações" → "Executar assim mesmo". Avise **antes** de mandar: um aviso vermelho do Windows sem contexto é o suficiente para a pessoa desistir.

**Caminho B — o testador roda do código (só se for dev).** Ele clona o repositório, preenche `apps/launcher/.env` com os endereços do seu servidor, e roda:

```bash
cd apps/launcher && npm ci && npm run dev
```

Em outro terminal, `npm start`.

## 1.6 Mande isto para os testadores

A Parte 2 deste documento foi escrita para ser copiada e enviada inteira. Mande junto:

- o link ou o instalador (1.5);
- o **modpack exato** — a lista de mods e a load order precisam bater com o `mods.json` que você gerou, ou a verificação de paridade barra a pessoa. Ver [`MODPACK.md`](../MODPACK.md);
- o convite do Discord, porque o login do launcher é por Discord e a voz da sessão vai ser por lá.

## 1.7 Desligar

Feche as janelas dos quatro serviços. Se ligou o VOIP com `VOIP_DEBUG_EXPOSE_TICKET`, **desligue a flag e apague `skymp/gamemode/.voip-debug-ticket.json`** — é uma credencial em texto puro no disco.

---

# Parte 2 — Para os testadores

> **Operador: copie daqui até o fim da Parte 2 e mande.** Está escrito para quem nunca viu o repositório.

## O que você precisa

- **Skyrim Special Edition ou Anniversary Edition** no PC (Windows). Não funciona com a versão de 2011 nem no Game Pass em alguns casos.
- **SKSE64** instalado.
- **Conta no Discord** — o login é por ela.
- O **modpack** que o organizador mandou, instalado exatamente como veio.
- **Fone de ouvido.** A voz da sessão é pelo Discord.

## Antes de entrar

1. Instale o modpack **na ordem que o organizador mandou**. A ordem dos mods importa: o servidor confere sua lista contra a dele e recusa a entrada se houver diferença — inclusive **um mod a mais**.
2. Instale o launcher que ele te enviou.
   - O Windows vai mostrar um aviso azul de "aplicativo não reconhecido". **É esperado.** O programa não tem assinatura digital ainda. Clique em "Mais informações" → "Executar assim mesmo".
3. Abra o launcher e faça login com o Discord.

## Entrar

1. O launcher verifica seus mods. **Se der erro aqui, copie o texto exato e mande no chat.** Essa mensagem é a informação mais valiosa que você pode produzir hoje.
2. Entre na fila.
3. O jogo abre e conecta sozinho.
4. Digite `/painel` no jogo. Deve abrir uma janela com quatro abas.

Se chegou aqui, você está dentro e o organizador vai conduzir o resto.

## O que **não** é bug

Estas três coisas vão acontecer e já são conhecidas. Não vale a pena reportar:

- **A voz no jogo não funciona.** Ao usar `/voz` você verá `VOZ INDISPONÍVEL NESTE CLIENT — use o Discord`. É uma limitação do cliente, não do seu microfone e não do servidor. **Fale pelo Discord.**
- **O aviso do Windows ao instalar.** Explicado acima.
- **Outro jogador aparece como "Desconhecido".** É de propósito — você só vê o nome de quem se apresentou a você (`/apresentar`).

## O que reportar, e como

Qualquer outra coisa. Principalmente:

- não consegui entrar (**com o texto exato do erro**);
- entrei e caí;
- um comando não fez nada;
- algo aconteceu diferente do que o organizador disse que aconteceria;
- travou, congelou ou ficou lento.

**Anote na hora, não no fim.** Ao reportar, diga: **o que você fez**, **o que esperava** e **o que aconteceu**. Uma print ajuda muito.

Não tente consertar nada nem reinstalar por conta própria antes de avisar — se você consertar sozinho, o problema desaparece sem ninguém entender qual era, e ele volta no próximo teste com outra pessoa.

---

# Parte 3 — Depois da sessão

Terminada a entrada de todo mundo, siga o [`FASE_0_ROTEIRO.md`](FASE_0_ROTEIRO.md) a partir da **Etapa 1**, em ordem. Cada etapa depende de a anterior ter passado: se a 2 falha, o resultado da 7 não significa nada.

Copie o registro em branco do fim do roteiro para um arquivo novo **antes de começar** e preencha **enquanto testa**. Memória de sessão de teste é ruim, e o valor está nos detalhes que ninguém lembra no dia seguinte.

O resultado vai para [`../roadmap/`](../roadmap/), no formato do [`FASE_0_LOG_2026-08-06.md`](../roadmap/FASE_0_LOG_2026-08-06.md). **Registre o que falhou com o mesmo cuidado do que passou** — a Fase 0 existe para descobrir isso, e uma sessão que quebrou na Etapa 1 e foi bem documentada vale mais que uma que "correu bem" sem registro.
