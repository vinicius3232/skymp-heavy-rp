# Gateway local — delegação e sessão alternativa

Ferramenta opcional. Nada no repositório depende dela: se o gateway não estiver
no ar em `localhost:20128`, os dois scripts falham com mensagem clara e o
trabalho segue normalmente.

O gateway é um proxy OpenAI-compatível (OmniRoute) que expõe modelos de contas
externas sob a API da Anthropic. A política de uso está na seção **Delegação ao
gateway local** do [`CLAUDE.md`](../../CLAUDE.md) — leia ela antes destes scripts,
porque ela diz o que *não* delegar.

## Ask-OmniRoute.ps1 — delegar sem trocar de sessão

Funciona em qualquer sessão, inclusive nas que estão na Anthropic. Manda arquivos
do repo para um modelo do gateway e devolve só a resposta; o conteúdo lido não
entra no contexto da sessão.

```powershell
powershell -File scripts/omniroute/Ask-OmniRoute.ps1 `
  -Prompt "onde o patrimonio escapa do transaction-service?" `
  -Files "skymp/gamemode/admin-actions.js" `
  -Model kiro/glm-5
```

| parâmetro | padrão | |
|---|---|---|
| `-Prompt` | — | obrigatório, salvo com `-Check` |
| `-Files` | — | vários caminhos, relativos à raiz do repo |
| `-Model` | `kiro/qwen3-coder-next` | validado por chamada real, não pelo catálogo |
| `-System` | — | prompt de sistema |
| `-MaxTokens` | `4096` | modelo com raciocínio gasta boa parte disso pensando |
| `-MaxFileKB` | `256` | guarda contra mandar arquivo gigante sem querer |
| `-Check` | — | descobre quais modelos respondem |

## Start-ClaudeViaOmniRoute.ps1 — sessão inteira pelo gateway

Abre uma sessão do Claude Code apontada para o gateway, usando o perfil
`~/.claude/profiles/skymp-omniroute/`. Esse perfil carrega quatro agentes com o
conhecimento deste repo embutido: `code-scout`, `suite-runner`, `schema-oracle`
e `mock-skeptic`.

```powershell
powershell -File scripts/omniroute/Start-ClaudeViaOmniRoute.ps1
```

`-Model <id>` troca o padrão e persiste no perfil. `-ListModels` lista o catálogo
inteiro. O script faz um probe real antes de abrir a sessão — se o modelo estiver
sem crédito, você descobre ali e não no meio do trabalho.

Trocar de modelo **não** converte uma sessão já aberta. `ANTHROPIC_BASE_URL` e o
perfil são lidos uma vez, no start.

## O catálogo mente

O gateway lista 548 modelos e quase nenhum responde. `capabilities.tool_calling`
vem `true` até para modelo de imagem e de embedding, então o campo não filtra
nada. Conta sem crédito, cota diária estourada e modelo aposentado continuam
listados normalmente.

O atalho honesto é `omniroute providers list`, que mostra o estado da conexão.
A prova é `-Check`, que faz chamada real com tool calling.

Roster da última verificação — **2026-08-15**:

| modelo | para quê |
|---|---|
| `kiro/claude-sonnet-4.5` | o mais forte; análise que exige julgamento |
| `kiro/claude-haiku-4.5` | rápido e barato; tarefa mecânica |
| `kiro/qwen3-coder-next` | dedicado a código, padrão do script |
| `kiro/glm-5` | código |
| `kiro/deepseek-3.2` | código |
| `kiro/minimax-m2.5` | código |
| `gemini/gemini-3.6-flash` | contexto de 1M; arquivo grande |
| `gemini/gemini-3.5-flash`, `-lite` | volume barato |
| `oc/big-pickle` | responde sem chave nenhuma — origem e política de dados desconhecidas; não mande código sensível |

Fora dessa lista, não funciona. `kiro/claude-sonnet-5` dá `Invalid model` mesmo
com a conexão kiro ativa; `gemini/gemini-2.5-pro` foi aposentado pelo Google e a
linha Pro vive em cooldown de cota; `aug/*` exige o CLI `auggie`; `tllm/*` dá 403.

**O que destrava mais:** `openrouter` e `deepseek` estão `credits_exhausted`.
Recarregar o OpenRouter libera cerca de 350 modelos, entre eles
`kat-coder-pro-v2.5`, `kimi-k3` e `laguna-s-2.1`.

## Compressão

O OmniRoute tem compressão de contexto (RTK + Caveman) que corta boa parte dos
tokens em trânsito. Ela está **desligada** — `omniroute compression status`
mostra `standard`.

Ligar exige token de scope `write`, e criar token exige `admin`; o bootstrap dos
dois é o login do dashboard:

```powershell
omniroute dashboard
omniroute --api-key SEU_TOKEN compression configure --engine hybrid --caveman-aggressiveness 0.5
```
