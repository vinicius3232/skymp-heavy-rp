# SkyMP Heavy RP — servidor de roleplay para Skyrim multiplayer

***Português** · [English](README.en.md) · [Русский](README.ru.md) · [Español](README.es.md)*

Base aberta e atual de **servidor de RP para Skyrim Special Edition multiplayer**, construída sobre o [SkyMP](https://github.com/skyrim-multiplayer/skymp). Gamemode em Node.js, painel de whitelist, launcher Electron e verificação de paridade de modpack.

Focada em *Roleplay Estrito*: autoridade do servidor sobre economia, identidade e consequência, sem comprometer a sincronização de rede.

> **Por que existe:** até agosto de 2026 a comunidade SkyMP não tem nenhuma base de servidor RP aberta e mantida. A única pública — o [Red House](https://github.com/alekcey0211/red-house-public) — está parada desde 2021 e é só em russo. Este projeto tenta preencher esse buraco.

> ⚠️ **Ainda não está pronto para produção.** O gamemode é verificado só por teste automatizado contra um `mp` mockado — **nada foi validado numa sessão de jogo real**. Ver o [relatório de QA](docs/technical/QA_REPORT_2026-08.md) para o estado honesto de cada componente.

## Para quem está chegando

| Você quer | Comece por |
|---|---|
| Entender o que o projeto **quer ser** | [CONSTITUICAO.md](docs/CONSTITUICAO.md) — a constituição de design |
| Entender o estado real do projeto | [QA_REPORT_2026-08.md](docs/technical/QA_REPORT_2026-08.md) — inclui o que **não** está pronto |
| Entender como as peças conversam | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Contribuir com código | [CONTRIBUTING.md](CONTRIBUTING.md) — as regras que não são óbvias lendo o código |
| Saber se um mod funciona no servidor | [MODS_AND_GAMEMODE_CONTRACT.md](docs/technical/MODS_AND_GAMEMODE_CONTRACT.md) §4 |
| Navegar toda a documentação | [docs/README.md](docs/README.md) — índice mantido dos documentos do projeto |
| Reportar falha de segurança | [SECURITY.md](SECURITY.md) — **não abra issue pública** |
| Perguntar, propor ou mostrar o que fez | [Discussions](https://github.com/vinicius3232/skymp-heavy-rp/discussions) |

**Sobre o idioma:** oito documentos existem em português, inglês, russo e espanhol — os três de entrada e os cinco que barram um dev de fora. O resto da documentação técnica fica **só em português** — traduzir tudo que muda toda semana produziria tradução desatualizada, que é pior que tradução nenhuma: é um documento em que as pessoas confiam e que mente calado. Se algum documento específico te travar, [peça nas Discussions](https://github.com/vinicius3232/skymp-heavy-rp/discussions/categories/q-a) que a gente traduz aquele.

## Status Atual do Projeto (Auditoria Recente)

- **Núcleo de Roleplay Avançado**: Foram implementados o **Governance Service** (Prisões, Multas, Impostos) e a **Economia Controlada** com ênfase no comércio entre jogadores via **Market Stalls**. O comércio regional (NPCs, `economy-regional.js`) foi desenhado como sistema punitivo de *spread* pra engajar trocas Player-to-Player, mas está **PARKED** (nunca registrado em produção) até passar por reengenharia — ver `docs/ARCHITECTURE.md` 1.4.
- **Morte com Consequência (`death-service.js`)**: HP≤0 agora vira estado `DOWNED` (não respawn automático) — outro jogador pode `/socorrer` a tempo, ou o personagem sangra até `DEAD`, leva uma penalidade real de ouro e só então respawna. Contexto de proximidade no momento da morte é registrado em `audit_logs` como evidência anti-RDM pra staff. Ver `docs/ARCHITECTURE.md` 1.4.3.
- **Morte Permanente (soft-delete)**: `/permakill` (staff admin/owner) aposenta um personagem permanentemente (`characters.status='retired'`, nunca `DELETE`), com motivo obrigatório e audit log.
- **Voz por Proximidade (`/voz`)**: sinalização WebRTC opt-in com autenticação por ticket de uso único (corrige um bug de sequestro de sessão de voz) e host/porta enviados dinamicamente pelo servidor. Antes existia só como código morto — nada disparava a conexão. Ver `docs/ARCHITECTURE.md` 1.4.4.
- **UI CEF / Menu de Interação Integrados**: A UI CEF e o gamemode Node.js agora possuem comunicação de eventos bi-direcional via um roteador central de eventos (`core/ui-event-router.js`). Jogadores podem interagir com outros jogadores e NPCs clicando através de um menu contextual para inspecionar, prender, multar ou abrir o painel de mercado, abandonando a necessidade de comandos de chat engessados.
- **Painel do Jogador (in-game)**: Comando `/painel` abre um HUD in-game com 4 abas — Status (vida/magicka/stamina/ouro/estado RP), Governança (cargo, mandados, multas), Economia (barracas, imposto local) e Social (rostos conhecidos). Agrega dados dos serviços existentes sem duplicar lógica de negócio; ativado via `ENABLE_PLAYER_PANEL_SERVICE=true`. Ver [player-panel-service.js](skymp/gamemode/player-panel-service.js).
- **Launcher App**: Um Launcher em React + Electron (Vite) em `apps/launcher`, controlando autenticação, configurações e boot da build. Na auditoria de agosto ele estava quebrado ponta a ponta (nenhuma variável de ambiente era carregada) e o client secret do Discord ia embutido no instalador — ambos corrigidos, mas ainda sem validação em runtime. Ver [QA_REPORT_2026-08.md](docs/technical/QA_REPORT_2026-08.md) 2.1 e 2.2.
- **Fase Inicial (Fase 0)**: As fundações locais (conexão, persistência base em banco MariaDB via scripts SQL migrados) já foram garantidas em ambiente de laboratório.

- **Afinidade da Alma**: `core/soul.js` contém o domínio puro (28 testes), enquanto `soul-service.js` persiste almas, entrega sinais, grava marcas, avança árvores e expõe `/alma`. O serviço está registrado atrás de `ENABLE_SOUL_SERVICE`, desligado por padrão e ainda aguarda homologação in-game. Desenho em [SOUL_AFFINITY.md](docs/design/SOUL_AFFINITY.md).

- **Fronteiras de confiança e ciclo de conexão**: eventos CEF passam por envelope validado, gateway único e rate limiter observável (`ui-event-gateway`, `ui-event-rate-limiter`); conexões e reconexões passam por `connection-monitor`, que invalida respostas assíncronas antigas. Credenciais opacas têm geração, hashing e redação centralizados em `core/opaque-credential.js`.

- **Economia transacional**: transferências entre tesouros e compras/vendas regionais usam transações, ledger e chaves de idempotência (`institutional-treasury-service`, `regional-market-transaction-service`, migrations v11–v12). Compras em barracas aceitam `requestId` e impedem cobrança duplicada via migration v13. A economia regional continua PARKED; as fronteiras já estão implementadas e testadas para uma futura ativação segura.

- **API do Jogo (`apps/game-api`)**: serve a porta 7758 que o launcher sempre chamou e que não existia — `/mods.json` (paridade de modpack, a base do contrato de FormID) e a fila de entrada com capacidade e expiração de reserva. A fila é autenticada por ticket emitido pelo painel, nunca pelo `discordId` que o cliente informa. Manifesto gerado por `scripts/generate-mods-manifest.js`.

> ⚠️ **O servidor ainda não foi validado com jogadores reais.** Todo o gamemode está verificado só por teste unitário com `mp` mockado — o próximo passo é rodar o [roteiro de teste in-game](docs/technical/FASE_0_ROTEIRO.md) com as flags `ENABLE_*` ligadas; para chegar até ele, o [guia de sessão](docs/technical/GUIA_SESSAO_DE_TESTE.md) explica como subir os quatro serviços. Plano completo em [QA_REPORT_2026-08.md](docs/technical/QA_REPORT_2026-08.md) §3.

## Como Executar o Servidor (Desenvolvimento)

Para facilitar a vida dos desenvolvedores, criamos um script de orquestração automatizado que inicia todas as dependências em terminais paralelos.

1. Inicie o seu servidor local de banco de dados (MariaDB/MySQL).
2. Navegue até a pasta `scripts/phase0/`.
3. Execute o script `Start-AllServices.ps1` com o PowerShell.

Isso irá despachar simultaneamente:
- O Painel Web do Staff (`apps/web`, porta 3001)
- O Bot de Autenticação do Discord (`apps/bot-discord`, porta 3002)
- A API do Jogo (`apps/game-api`, porta 7758 — paridade de modpack e fila)
- O Servidor SkyMP Nativo (`skymp/gamemode`, porta 7777)

O script pré-checa `.env` e `node_modules` de cada serviço e diz o que não vai subir, em vez de reportar sucesso com um serviço morto.

*(Para testar como jogador, basta rodar o aplicativo de interface do Launcher na pasta `apps/launcher`).*

### Ferramentas de debug que já existem

- **`localhost:9000`** no seu navegador normal abre o **DevTools do navegador embutido do jogo** — console, inspetor e breakpoints da UI in-game (`skymp/ui/`). Sem isso a UI é depurada às cegas.
- O servidor SkyMP faz **proxy da UI pra um dev server na porta 1234**, se houver um rodando — live reload de CSS/JS da UI sem reiniciar nada.

Mais em [SKYMP_UPSTREAM_REFERENCE.md](docs/technical/SKYMP_UPSTREAM_REFERENCE.md).

---

## Projetos relacionados

Quem procura por servidor RP de Skyrim multiplayer costuma esbarrar nestes. O mapa ajuda a entender onde cada um está:

| Projeto | O que é | Estado |
|---|---|---|
| [skyrim-multiplayer/skymp](https://github.com/skyrim-multiplayer/skymp) | A plataforma. Servidor C++, Skyrim Platform e SDK TypeScript. **Este projeto roda em cima dele.** | Ativo |
| [alekcey0211/red-house-public](https://github.com/alekcey0211/red-house-public) | Build pública de servidor RP, GPL-3.0. A única que existia. Estudada em detalhe [aqui](docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md). | Parado desde 2021, em russo |
| [alekcey0211/skymp5-scripts](https://github.com/alekcey0211/skymp5-scripts) | Scripts Papyrus para RP, do mesmo autor do Red House. | Parado desde 2021 |
| [skyrim-roleplay](https://github.com/skyrim-roleplay) (Keizaal Online) | Organização de um servidor RP. O fork do SkyMP é público; o gamemode não. | Ativo, código de RP fechado |
| [Silveira-Software/SKYRIMRP-BR](https://github.com/Silveira-Software/SKYRIMRP-BR) | Servidor RP brasileiro, em PT-BR. O repositório é só de divulgação — o código é fechado. | Ativo, código fechado |

**O buraco que este projeto tenta preencher:** os servidores ativos mantêm o gamemode fechado, e o único aberto está parado há anos. Quem quer montar um servidor RP hoje não tem de onde partir.

---

## Licença

Este projeto é software livre sob **[GNU AGPL-3.0-or-later](LICENSE)**.

A escolha é deliberada: o objetivo é ser uma **build pública e atual de servidor RP para a comunidade SkyMP** — hoje não existe nenhuma, já que o [Red House](https://github.com/alekcey0211/red-house-public) parou em 2021. AGPL não nos custa nada que já não pretendíamos dar, e protege o objetivo: quem modificar esta base e rodar um servidor **precisa oferecer as modificações aos jogadores** (AGPL §13).

É também a mesma licença do `skymp5-server`, sobre o qual tudo aqui roda.

Se você rodar uma versão modificada, o link da fonte precisa apontar pra **sua** versão. Ver [PUBLIC_BUILD_GUIDE.md](docs/technical/PUBLIC_BUILD_GUIDE.md) §3 e [LICENSE_AND_AFFILIATION_POLICY.md](docs/technical/LICENSE_AND_AFFILIATION_POLICY.md).

**A licença cobre o nosso código, não mods de terceiros nem assets da Bethesda.** Nada da Bethesda é redistribuído aqui — você precisa possuir o Skyrim.

> Este projeto é uma iniciativa independente da comunidade. Não é afiliado, endossado ou patrocinado pela Bethesda Softworks, ZeniMax Media, Microsoft ou qualquer detentor oficial da marca The Elder Scrolls/Skyrim. Todas as marcas pertencem aos seus respectivos proprietários.
