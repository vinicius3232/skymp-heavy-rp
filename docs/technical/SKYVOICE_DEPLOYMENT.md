# SkyVoice — deployment e operação

**Data:** 2026-08-14
**Escopo:** subir, operar e diagnosticar a voz em produção. Etapa 4.

> ⚠️ **Nada deste documento foi executado.** Não há `livekit-server` nesta
> máquina, nenhum `docker compose up` rodou contra `deploy/livekit/`, e nada do
> projeto jamais saiu de `127.0.0.1`. O que existe aqui é uma configuração
> **reproduzível e verificável**, derivada da documentação oficial e do spike da
> Etapa 1 (que rodou o `livekit-server 1.13.5` como binário solto). Trate como
> ponto de partida, não como configuração provada.

---

## 1. A regra que a arquitetura preserva

```
   LiveKit  =  transporte de mídia
   SkyMP    =  autoridade do mundo
   SkyVoice =  gameplay de voz
```

O gamemode decide quem ouve quem, com que volume, com que efeito e com que
direção. O SFU move bytes. Trocar o SFU não toca em nenhuma regra de jogo — e é
isso que a §7 (self-hosted ↔ Cloud) explora.

---

## 2. Portas

| Porta | Protocolo | Quem usa | Exposição |
|---|---|---|---|
| **7880** | TCP / HTTP+WS | cliente (sinalização), gamemode (API Twirp) | atrás do TLS (443) |
| **7881** | TCP | mídia, alternativa quando UDP é bloqueado | pública |
| **50000–60000** | **UDP** | **mídia** | **pública** |
| **3478** | UDP | TURN | pública |
| **5349** | TCP/TLS | TURN sobre TLS | pública |
| **443** | TCP | Caddy → 7880 | pública |
| **80** | TCP | desafio ACME (Let's Encrypt) | pública |
| 7778 | TCP/WS | relay legado (`voip-service`) | **só 127.0.0.1** |
| 7777 | — | SkyMP | pública |

**A faixa UDP não é negociável e é o que mais quebra deploy.** Estreitá-la parece
inofensivo (menos regra de firewall) e é a forma mais provável de descobrir, numa
noite de evento, que o servidor parou de aceitar publicação nova. Dez mil portas
cobrem ~200 pessoas com folga para o churn de reconexão.

**7881 (TCP) importa mais do que parece.** É o caminho de quem joga de rede
corporativa ou de operadora que bloqueia UDP. TCP para mídia em tempo real sofre
com head-of-line blocking — uma perda vira travada em vez de chiado —, mas é a
diferença entre "voz ruim" e "voz nenhuma".

---

## 3. Firewall

```bash
# UFW — o mínimo, e nada além
ufw allow 80/tcp                 # ACME
ufw allow 443/tcp                # sinalização sobre TLS
ufw allow 7881/tcp               # mídia, fallback TCP
ufw allow 50000:60000/udp        # mídia
ufw allow 3478/udp               # TURN
ufw allow 5349/tcp               # TURN sobre TLS
ufw enable
```

**A 7880 NÃO é aberta.** Ela é alcançada pelo Caddy em `127.0.0.1`. Abrir a 7880
publicamente é oferecer a mesma sinalização sem TLS ao lado da versão com TLS — e
um cliente mal configurado escolheria a errada, entregando o access token em
texto puro.

**A 7778 NÃO é aberta.** O relay legado não fala TLS. `VOICE-SEC-006` derruba o
boot em produção se `VOIP_BIND_HOST` for curinga; o firewall é a segunda camada.

`network_mode: host` no compose é o que torna o firewall obrigatório e não
opcional: o container vê todas as interfaces do host. A alternativa — mapear
10.000 portas — faz o Docker criar 10.000 regras de userland proxy, com consumo
de memória absurdo e latência somada em cada pacote de voz.

---

## 4. DNS

Dois nomes, e os dois precisam resolver **antes** de subir o Caddy — o desafio
ACME falha se não resolverem, e o sintoma é o Caddy reiniciando em laço.

| Nome | Tipo | Aponta para | Serve |
|---|---|---|---|
| `voz.exemplo.tld` | A / AAAA | IP público do SFU | sinalização e API |
| `turn.exemplo.tld` | A / AAAA | o mesmo IP | TURN |

Conferir antes de subir:

```bash
dig +short voz.exemplo.tld
curl -4 -fsS https://ifconfig.me      # tem que ser o mesmo IP
```

Nomes separados existem porque o certificado de TURN precisa bater com o
`turn.domain` do `livekit.yaml`. Um TURN com nome errado no certificado falha no
handshake TLS, e o sintoma é "alguns jogadores não se ouvem" — exatamente os que
precisavam de relay, que são os que estão atrás de CGNAT.

---

## 5. TLS

**Obrigatório em produção, e o boot recusa subir sem ele** (`VOICE-SEC-003`).

O access token do LiveKit é um portador: quem o tem é quem ele diz que é, até
expirar. Mandá-lo por `ws://` o entrega a qualquer intermediário do caminho — e o
caminho, em produção, é a internet.

| Camada | Como |
|---|---|
| Sinalização (7880) | Caddy termina TLS na 443 e faz proxy para `127.0.0.1:7880` |
| TURN (5349) | certificado emitido pelo Caddy, lido pelo LiveKit (`external_tls: true`) |
| Mídia (UDP) | **DTLS-SRTP**, do próprio WebRTC — cifrada por construção, não depende do Caddy |
| Relay legado (7778) | **nenhum.** Por isso ele é loopback |

**Por que Caddy e não o TLS embutido do LiveKit.** O LiveKit sabe terminar TLS
sozinho. A escolha é sobre **renovação**: com Caddy o certificado renova sem
reiniciar o SFU, e reiniciar o SFU derruba a voz de todo mundo na sala. Um
certificado vence a cada 90 dias; uma queda de voz trimestral é evitável.

Quem preferir o TLS embutido: remova o serviço `caddy`, preencha
`turn.cert_file`/`key_file`, e aceite o restart.

---

## 6. TURN

**Não é opcional para este projeto**, e a razão é o público: jogador residencial
brasileiro, boa parte atrás de CGNAT. Dois jogadores em CGNAT não fecham conexão
direta, e sem TURN eles simplesmente não se ouvem — com o servidor reportando
tudo saudável.

O relay atual (WebSocket PCM) resolvia isso **por acidente**: todo áudio passava
pelo servidor, então nunca houve conexão direta a falhar. Trocar para SFU sem
TURN seria trocar um acidente que funcionava por um desenho que não funciona.

O TURN do LiveKit é embutido (`turn.enabled: true`) — não há coturn separado a
manter.

---

## 7. Trocar entre self-hosted e LiveKit Cloud

**Sem tocar em gameplay.** A superfície inteira é três variáveis de ambiente:

```diff
- LIVEKIT_URL=wss://voz.exemplo.tld
+ LIVEKIT_URL=wss://meu-projeto.livekit.cloud
- LIVEKIT_API_KEY=APIabc...
+ LIVEKIT_API_KEY=APIxyz...
- LIVEKIT_API_SECRET=...
+ LIVEKIT_API_SECRET=...
```

O que **não** muda: `voice-policy`, `voice-route-engine`, `voice-conditions`,
`voice-occlusion`, `voice-spatial`, os alcances, os efeitos, o HUD, o
`server-options`. Nenhum arquivo de regra sabe onde o SFU está.

O que torna isso verdade:

1. **O gamemode assina os próprios tokens** (`livekit-token.js`, HS256 com
   `node:crypto`). Não há SDK que precise saber de endpoint.
2. **`httpBaseFrom()`** deriva a URL da API de sala da `LIVEKIT_URL` — `wss:` →
   `https:`. Não existe uma segunda variável a manter coerente com a primeira.
3. **`resolveLiveKitConfig()` lê o ambiente por chamada**, não uma vez no load.
   Trocar de SFU não exige reiniciar por causa de configuração congelada.

**O que muda de verdade:** operação. Cloud tira firewall, TURN, DNS, TLS e
capacidade de UDP da sua conta; self-hosted tira a fatura e o dado sai da sua
máquina. É decisão de operação, e a arquitetura não a força.

**NÃO TESTADO:** a troca nunca foi exercitada. O que está verificado é que
nenhum módulo de regra importa configuração de transporte.

---

## 8. Health checks

| O quê | Como | Bom |
|---|---|---|
| SFU vivo | `curl -fsS http://127.0.0.1:7880/` | 200 |
| TLS válido | `curl -fsS https://voz.exemplo.tld/` | 200, sem aviso de certificado |
| Container | `docker compose ps` | `healthy` |
| UDP alcançável | `nc -uzv <ip> 50000` de **fora** | aberto |
| Gateway do gamemode | `voice_server_errors` e o `gatewayState` do diagnóstico | `CONNECTED` |

O healthcheck do compose bate no endpoint raiz do LiveKit — o mesmo que o
`livekit-gateway` alcança. Checar outra coisa provaria que o container vive, não
que a voz funciona.

**Do lado do jogo**, o health check real é o diagnóstico da staff:

```
/vozdiag <actorId>
```

que responde `gatewayState`. `FAILED` significa circuito aberto: a voz degradou,
o jogo não.

---

## 9. Restart

| Situação | O que fazer | Impacto |
|---|---|---|
| Trocar `livekit.yaml` | `docker compose up -d livekit` | **derruba a voz de todo mundo na sala** |
| Renovar certificado | nada — o Caddy faz sozinho | nenhum |
| Trocar chave de API | reiniciar SFU **e** gamemode | derruba a voz; tokens antigos passam a ser recusados |
| Gamemode reiniciou | nada no SFU | ⚠️ **o silêncio de staff é perdido** (SV-07) |
| SFU caiu sozinho | `restart: unless-stopped` recupera | circuito abre, jogo segue, voz volta no cooldown |

**A linha do silêncio de staff é a que exige atenção operacional.** Antes de
reiniciar o gamemode, liste quem está silenciado — o registro vive em memória.

---

## 10. Logs

| Fonte | Onde | Retenção |
|---|---|---|
| SFU | `docker compose logs -f livekit` | 20 MB × 5 arquivos |
| Caddy | `/data/access.log` | 20 mb × 5 |
| Gamemode (voz) | stdout do servidor, prefixo `[voip]`, `[voice-core]`, `[voice-security]` | do processo |
| Auditoria de staff | tabela `audit_logs` | banco |

**Teto obrigatório nos dois primeiros.** Sem ele, o log de um SFU com 200 pessoas
enche o disco — e um disco cheio derruba o MySQL antes de derrubar a voz.

⚠️ **`logging.level: debug` no LiveKit não vai para produção com jogadores.** Ele
não grava áudio (o LiveKit não faz isso sem Egress configurado), mas registra
eventos por faixa e por participante — um registro de **quem publicava para quem
e quando**, que é conversa por metadado. Fora de uma janela de depuração
declarada, a política de privacidade não o permite.

**O que os logs de voz do gamemode NUNCA carregam:** conteúdo de conversa,
amostra de áudio, nível de fala por pessoa. Código de erro de cliente é
higienizado (`[^a-zA-Z0-9_.-]` removido) e truncado em 48 caracteres.

---

## 11. Variáveis de ambiente

### Servidor de voz (`deploy/livekit/.env`)

| Variável | Obrigatória | Nota |
|---|---|---|
| `LIVEKIT_API_KEY` | sim | viaja no `iss` de todo token |
| `LIVEKIT_API_SECRET` | sim | **≥ 32 caracteres**; o boot do gamemode reprova abaixo disso |
| `LIVEKIT_DOMAIN` | sim | precisa resolver antes de subir |
| `TURN_DOMAIN` | sim | precisa bater com o certificado |

### Gamemode (`skymp/gamemode/.env`)

| Variável | Padrão | Nota |
|---|---|---|
| `ENABLE_VOIP_SERVICE` | `false` | é ela que liga a voz |
| `VOICE_BACKEND` | `legacy` | `legacy` \| `livekit`. **Não** liga a voz |
| `LIVEKIT_URL` | — | `wss://` em produção, ou o boot cai |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | — | **idênticas** às do SFU |
| `LIVEKIT_ROOM` | `skyvoice` | uma sala para o servidor |
| `VOIP_BIND_HOST` | `127.0.0.1` | curinga + sem TLS derruba o boot em produção |
| `VOICE_ALLOWED_ORIGINS` | vazio | allowlist do WS legado; vazio aceita tudo |
| `VOIP_DEBUG_EXPOSE_TICKET` | ausente | **`true` derruba o boot em produção** |
| `VOICE_TICK_MS` | `150` | não baixe sem rodar `npm run bench:voice` |
| `VOICE_SPEECH_ANIMATION` | `false` | nomes de evento não conferidos |

**As duas chaves existem em exatamente dois lugares: o `.env` do SFU e o `.env`
do gamemode.** Não vão para o launcher, o painel, o bot ou o cliente. Quem tem o
secret forja qualquer identidade em qualquer sala.

---

## 12. Subir, do zero

```bash
# 1. DNS primeiro. Sem isto o Caddy reinicia em laço.
dig +short voz.exemplo.tld turn.exemplo.tld

# 2. Chaves
cd deploy/livekit && cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → LIVEKIT_API_SECRET

# 3. Domínios no livekit.yaml e no Caddyfile
#    (turn.domain e os dois blocos de site)

# 4. Firewall — ANTES de subir, por causa do network_mode: host
ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 7881/tcp \
  && ufw allow 50000:60000/udp && ufw allow 3478/udp && ufw allow 5349/tcp

# 5. Sobe
docker compose --env-file .env up -d
docker compose ps                      # healthy?
curl -fsS https://voz.exemplo.tld/     # 200?

# 6. Gamemode: as MESMAS chaves
#    VOICE_BACKEND=livekit, LIVEKIT_URL=wss://voz.exemplo.tld
#    O boot audita e recusa subir se algo estiver indefensável.
```

---

## 13. Launcher

O jogador **não** copia ticket, **não** roda helper à mão, **não** edita
configuração e **não** instala patch. O launcher faz:

| Passo | Onde | Estado |
|---|---|---|
| Buscar `voice-dist.json` | `parseVoiceManifest` | ✅ testado |
| Recusar manifesto sem `sha256` | idem | ✅ testado |
| Recusar `downloadUrl` sem HTTPS | idem | ✅ testado |
| Decidir install/update/reinstall/rollback | `decideVoiceAction` | ✅ testado |
| Conferir hash antes de instalar | `verifyHash` | ✅ testado |
| Gerar `pairingToken` por execução | `main.ts` | 🟡 lógica pronta, fiação pendente |
| Iniciar o helper sem ticket na linha de comando | `helperArgs` | ✅ testado |
| Entregar o ticket CEF → helper | canal de controle loopback | 🔴 **lado C++ não existe** |
| Desligar o helper ANTES do jogo | `shutdownOrder` | ✅ testado |

**O handoff automático de credencial não fecha nesta etapa.** O launcher gera o
`pairingToken`, monta os argumentos e sabe a ordem de desligamento. O
`voice-helper.exe` precisa aprender `--control-port` e `--pair`, e isso é C++ que
não foi escrito nem compilado.

Enquanto não fechar, o caminho de bancada continua sendo
`VOIP_DEBUG_EXPOSE_TICKET` — que **não sobe em produção**, porque o boot recusa.

O desenho:

```
  launcher                     jogo                          helper
     │ 1. pairingToken (aleatório, por execução)               │
     │──── grava no config ────►│                              │
     │──── inicia com --control-port e --pair ─────────────────►│
     │                     2. /voz                             │
     │                          │◄── voipTicket (do servidor)  │
     │                     3. POST 127.0.0.1:<port>/ticket     │
     │                          │──── {pair, actorId, ticket} ►│
     │                          │                      4. autentica no VOIP
```

O `pairingToken` é o que impede qualquer processo local de mandar um ticket ao
helper. Novo a cada execução, só em memória e no config local, sem valor em outra
máquina ou sessão.

---

## 14. Diagnóstico e administração

Três comandos, permissão `voice_mute` (moderador+), **todos com audit log**:

| Comando | O que faz |
|---|---|
| `/vozdiag <actorId>` | os treze campos + o motivo de não estar sendo ouvido |
| `/vozdesconectar <actorId> [motivo]` | derruba a voz **sem tirar do jogo** |
| `/vozreconectar <actorId>` | reemite o token **mantendo a identidade** |
| `/calar` · `/descalar` | silêncio de staff (já existia) |

`/vozdesconectar` é separado de `/kick` de propósito: um cliente de voz travado se
resolve derrubando a voz, e derrubar o jogador junto é uma punição que ele não
recebeu.

`/vozreconectar` mantém a identidade porque trocá-la faria a volta parecer uma
chegada e derrubaria as assinaturas que os outros já têm. Ele também **recalcula
a permissão durável** — um `/calar` aplicado enquanto o gateway estava fora passa
a valer no token.

**A consulta também gera audit log.** Consultar o estado de voz de um jogador é
olhar o que ele está fazendo; num sistema de moderação, quem olhou também é
registro.

---

## 15. Métricas

Dez métricas, servidas em formato Prometheus por `renderPrometheus()`. O módulo
**não abre porta** — quem serve é quem já tem servidor.

| Métrica | Tipo |
|---|---|
| `voice_connected_players` | gauge |
| `voice_active_speakers` | gauge |
| `voice_subscription_count` | gauge |
| `voice_connection_quality{quality=…}` | gauge, 5 faixas |
| `voice_reconnects` | counter |
| `voice_auth_failures` | counter |
| `voice_subscription_changes` | counter |
| `voice_policy_denies` | counter |
| `voice_client_errors` | counter |
| `voice_server_errors` | counter |
| `voice_recompute_milliseconds{quantile=…}` | summary |

**Nenhuma carrega `actorId`, `characterId` ou nome** — há teste que reprova se
carregarem. Uma exposição de métrica com identificador seria um registro de quem
falou com quem.

Sem coletor, `logLine()` dá a mesma informação numa linha: um número que só
existe atrás de um Prometheus que ninguém instalou é um número que não existe.

---

## 16. Troubleshooting

| Sintoma | Causa provável | Como confirmar |
|---|---|---|
| "conecta e ninguém ouve ninguém" | assinatura não sai | `/vozdiag` → `gatewayState`; SV-05 |
| Só alguns não se ouvem | TURN quebrado / certificado errado | `nc -uzv <ip> 3478`; conferir `turn.domain` |
| Voz trava e volta | UDP bloqueado, caiu para TCP na 7881 | latência subiu, perda vira travada |
| Servidor não sobe, `[voice-security] FATAL` | ambiente indefensável | a linha do log nomeia o ID e a correção |
| Voz volta depois do restart de quem foi calado | SV-07 — não persiste | esperado, registrado |
| Boca do personagem não mexe | `VOICE_SPEECH_ANIMATION=false` por padrão | nomes de evento não conferidos |
| Caddy reiniciando em laço | DNS não resolve | `dig +short` |
| Disco cheio | log sem teto | conferir `max-size` no compose |

---

## Fontes

**Internas:** [`SKYVOICE_SECURITY_AUDIT.md`](SKYVOICE_SECURITY_AUDIT.md) ·
[`SKYVOICE_LIVEKIT_AUDIT.md`](SKYVOICE_LIVEKIT_AUDIT.md) ·
[`SKYVOICE_CORE_ETAPA_3.md`](SKYVOICE_CORE_ETAPA_3.md) ·
[`LAUNCHER_DISTRIBUTION.md`](LAUNCHER_DISTRIBUTION.md) ·
[`OPERATIONS.md`](OPERATIONS.md)

**Arquivos:** `deploy/livekit/{docker-compose.yml,livekit.yaml,Caddyfile,.env.example}`

**LiveKit:** [Deploy](https://docs.livekit.io/home/self-hosting/deployment/) ·
[Ports & firewall](https://docs.livekit.io/home/self-hosting/ports-firewall/) ·
[Benchmark](https://docs.livekit.io/home/self-hosting/benchmark/)
