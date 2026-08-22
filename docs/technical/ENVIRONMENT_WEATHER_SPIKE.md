# Spike — Sincronização de Clima (ForceWeather)

Status: **pesquisa, sem implementação.** Nenhum `weather-service.js` existe no
disco. Nenhuma flag `ENABLE_WEATHER_SERVICE` foi adicionada ao `.env.example`
— uma flag para um módulo que não existe reproduziria exatamente o problema
que `core/server-options.js` documenta em `DECLARED_BUT_UNWIRED` (configuração
que parece existir e não faz nada).

## Por que parou aqui

1. **`skymp/gamemode/types/mp.d.ts` não declara nenhum binding de
   `Weather`/`WorldTime`/`ForceWeather`.** A API JS do SkyMP usada por este
   projeto não tem uma função pronta para clima — grep confirmado, zero
   ocorrências (o único hit do repositório inteiro para essas palavras era
   este próprio backlog).
2. **`docs/MODDING_GUIDELINES.md:55` já registra a dúvida como em aberto**,
   escrita antes desta tarefa começar: *"Cathedral Weathers: É apenas um
   candidato. Se a transição global não puder ser controlada identicamente
   pelo servidor via reconnect e mudança de célula, não será usado de forma
   dinâmica."* Ou seja: o próprio projeto já sabia que "clima sincronizado
   suave" é uma pergunta em aberto, não uma feature pronta pra implementar.

## Candidato técnico — e por que ele está bloqueado, não só "não testado"

`Game.ForceWeather` é uma função nativa do Papyrus vanilla do Skyrim
(`Game.psc`, `ForceWeather(Weather akWeather, bool abInterior = false)`). O
padrão de chamada já usado neste projeto para funções globais Papyrus (ver
`admin-service.js:194` e `crafting-service.js:64`) seria:

```js
mp.callPapyrusFunction('global', 'Game', 'ForceWeather', null, [weatherFormRef, false]);
```

**Confirmado bloqueado, não apenas hipotético**: `skymp/gamemode/core/skymp-adapter/papyrus-catalog.js`
— a lista extraída do C++ do servidor SkyMP upstream (`Papyrus*.cpp`, ver o
cabeçalho daquele arquivo) — lista as funções `game.*` que este build
implementa (`disableplayercontrols`, `forcethirdperson`, `getform`, etc.).
`forceweather` **não está na lista**. Chamar mesmo assim não lançaria: o VM
loga erro e devolve `null` em silêncio, exatamente a armadilha que o header do
`papyrus-catalog.js` documenta. Não é um problema de FormDesc — é a chamada
nativa não existir neste servidor, ponto.

O mesmo vale para o candidato equivalente de tempo (`GlobalVariable.SetValue`,
usado por `environment-service.js` para tentar corrigir `GameDaysPassed`/
`TimeScale` no cliente): também ausente da lista. Os dois blocos do
`EnvironmentService` — tempo e clima — batem na mesma parede.

Nenhum código chama `Game.ForceWeather` neste projeto.

## Riscos não resolvidos

| Risco | Por quê importa | Como resolver |
|---|---|---|
| **`Game.ForceWeather` não está implementado por este SkyMP** | Confirmado em `papyrus-catalog.js` — não é um risco a mitigar, é um bloqueio a contornar. | Só um upstream do SkyMP que implemente a chamada, OU uma abordagem que não dependa dela (ex: script Papyrus custom rodando no lado do mod, fora do controle direto do servidor — herda a fronteira de confiança que `docs/CONSTITUICAO.md` §A.7 já discute para vampirismo). |
| Transição abrupta vs. suave | Mesmo SE a chamada existisse, o Skyrim vanilla pode trocar o clima instantaneamente em vez de fazer a transição gradual que a engine faz sozinha com o tempo. Nenhuma fonte confirma o comportamento. | Fica sem objeto até o bloqueio acima ser resolvido. |
| Compatibilidade com Cathedral Weathers | `MODDING_GUIDELINES.md:55` já assume que este mod pode não ser viável para clima dinâmico controlado pelo servidor. | Idem — sem objeto até haver um caminho técnico viável para testar. |
| Custo de round-trip Papyrus | `docs/technical/PAPYRUS_USAGE_POLICY.md:142` documenta 13–35 ms por chamada Papyrus (medição do Red House). Um broadcast de clima para N jogadores multiplica esse custo. | Relevante só se um caminho alternativo à chamada nativa aparecer. |
| Sem consumidor de gameplay ainda | Nada no projeto hoje reage a clima (nenhuma mecânica de exaustão/combate/economia liga em clima). | Adiar até `HEAVY_RP_GAMEPLAY_SYSTEMS_BACKLOG.md` ter um consumidor concreto de clima definido — mas mesmo com consumidor definido, o bloqueio técnico acima vem primeiro. |

## Próximo passo, se alguém retomar isto

1. Rodar a Etapa de sessão real (`FASE_0_ROTEIRO.md`) especificamente para
   `Game.ForceWeather` — confirmar transição suave/abrupta e compatibilidade
   com Cathedral Weathers.
2. Só depois disso, os 15 pontos da §15 completos para Clima (este documento
   não os responde — não há decisão de design a validar antes de saber se a
   capacidade técnica existe).
3. Se confirmado viável: `weather-service.js` no padrão de
   `environment-service.js` (mesmo `_deps`, mesmo `moduleRegistry.register`
   com `phase: 'lab'` e flag em `false`), migration própria para persistir
   `current_weather`/`override_weather` (a distinção pedida no brief original
   entre clima "natural" e forçado por staff/evento).
