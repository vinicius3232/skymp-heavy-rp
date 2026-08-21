# SkyMP Heavy RP — instruções para agentes

Servidor público de Skyrim Heavy RP sobre o framework **SkyMP**. Separação
estrita entre a plataforma RP (painel web, whitelist, loja) e o estado nativo
in-game (posições, mundo).

As regras de produto vivem em [`.agents/AGENTS.md`](.agents/AGENTS.md) e são a
fonte da verdade sobre design. Este arquivo existe porque o Claude Code não lê
aquele caminho — e porque há armadilhas operacionais que não estão lá.

## Banco de dados (crítico)

- O banco oficial é **MariaDB / MySQL**. **Nunca** sugira, migre ou crie schema
  para PostgreSQL.
- Todo acesso é via `mysql2/promise`.
- **`schema.sql` não é o schema.** O que o banco deve ter é `schema.sql` **mais**
  todas as `migration-v*.sql` de `skymp/packages/database/`, aplicadas em ordem.
  Ler só o `schema.sql` leva a conclusões erradas sobre colunas e tabelas.
- Antes de afirmar qualquer coisa sobre a estrutura do banco:
  `npm run check:schema:list` (em `skymp/gamemode/`, não precisa de banco).
- Mudança de estrutura exige migration nova versionada. As migrations são
  aplicadas **à mão** e nada garante que foram todas aplicadas — um banco
  meio-migrado é a falha mais cara do projeto porque tudo *quase* funciona.

## Testes

- `node --test` puro, sem framework. Cada pacote tem seu `package.json` e seu
  `package-lock.json` próprios: `skymp/gamemode`, `apps/web`, `apps/game-api`,
  `apps/bot-discord`, `apps/launcher`.
- **A lista de testes do gamemode é escrita à mão** no `scripts.test` do
  `package.json`. Um `.test.js` novo que não for adicionado ali **nunca roda, e o
  CI fica verde**. Ao criar teste no gamemode ou em `skymp/ui`, registre-o.
  Confira com `node scripts/check-test-registry.js`.
- **Suíte verde não significa que funciona em jogo.** Os testes do gamemode usam
  um `mp` mockado, e mock aceita qualquer coisa — foi assim que 22 chamadas
  Papyrus com argumento errado passaram meses despercebidas. Ao revisar teste,
  pergunte se ele verifica *efeito* ou só que o mock foi chamado.
- Mutação de estado é obrigatória nos testes de patrimônio: valor de jogador
  passa pelo `transaction-service`, nunca por escrita direta.

## Convenções que falham em silêncio

- **FormDesc**: célula e base são `"162e2:Skyrim.esm"` — hex **sem prefixo**,
  `:`, nome do arquivo. Um `0x162e2` não lança erro; só não funciona em jogo.
  Ver [`death-service.js`](skymp/gamemode/death-service.js).
- **LiveKit**: a API responde `200` mesmo sem fazer nada. Quem decide é
  `track_sids`. Teste sempre por efeito (o ouvinte recebeu a faixa?), nunca por
  código HTTP.
- **Quadros de voz**: o LiveKit quer 10 ms, o resto do projeto fala 20 ms.
  Reenquadrar não é detalhe, é requisito.

## CI e verificação

- O workflow de CI cobre o que roda sem Skyrim e sem banco. Nada de
  comportamento in-game é verificado lá.
- Merge feito pela API com token de OAuth **não dispara o workflow** — já houve
  commit entrando na `main` sem check-run. Enquanto isso valer, a verificação
  local é a real: os cinco `npm test`, mais `test:systems`,
  `check:schema:list`, `node patches/validate.js`.
- Patch ao upstream do SkyMP só entra registrado em `patches/manifest.json`.
  Nunca aplicar patch pela metade.

## Produto

- RP Estrito: ações precisam de motivação in-game plausível.
- Progressão e economia são **intencionalmente lentas**.
- Monetização (VIP/Apoiador) existe para sustento. Mecânicas de Pay-to-Win são
  proibidas no design.

## Ambiente local

- Testes locais assumem `offlineMode=true` no artefato do servidor, o que libera
  `profileId`. Em produção isso é **expressamente proibido**.
- Setup, instalação de cliente e boot do servidor usam os scripts PowerShell de
  `scripts/phase0/`.
- Nunca versionar `.env` nem asset da Bethesda (`.esm`, `.bsa`). O CI barra os
  dois, mas o custo de errar é alto.

## Delegação ao gateway local (opcional)

Existe um gateway OpenAI-compatível opcional em `localhost:20128` que dá acesso a
modelos de fora. Nada neste repositório depende dele: se não estiver no ar,
ignore esta seção inteira e trabalhe normalmente.

Quando estiver, use-o para tirar volume do contexto — ler arquivo grande, varrer
diretório, resumir log, pedir segunda opinião:

```
powershell -File scripts/omniroute/Ask-OmniRoute.ps1 -Prompt "<pergunta>" -Files "<caminho>" -Model <id>
```

`-Files` aceita vários caminhos relativos à raiz. A resposta volta como texto; o
contexto lido não entra na sessão.

**O que não delegar.** Decisão de arquitetura, revisão de teste do gamemode e
qualquer afirmação sobre o schema do banco ficam na sessão principal. As três
armadilhas deste projeto — o `mp` mockado que aceita qualquer argumento, o banco
meio-migrado, o FormDesc que erra em silêncio — produzem, num modelo mais fraco,
resposta confiante e errada. Delegue leitura, não julgamento.

**Nunca confie no catálogo do gateway.** Ele lista centenas de modelos e a maioria
não responde: conta sem crédito, cota estourada, modelo aposentado que continua
listado. `capabilities.tool_calling` vem `true` até para modelo de imagem.
Descubra o que está vivo por chamada real:

```
powershell -File scripts/omniroute/Ask-OmniRoute.ps1 -Check
```

Mesma regra do LiveKit, um parágrafo acima: testar por efeito, nunca por listagem.
`scripts/omniroute/README.md` registra o roster da última verificação.
