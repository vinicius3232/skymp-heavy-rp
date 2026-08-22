# Environment Audit — Time Sync (§15 da Constituição)

Código: [`skymp/gamemode/environment-service.js`](../../skymp/gamemode/environment-service.js).
Migration: [`skymp/packages/database/migration-v19-environment-time.sql`](../../skymp/packages/database/migration-v19-environment-time.sql).
Testes: [`skymp/gamemode/environment-service.test.js`](../../skymp/gamemode/environment-service.test.js).

`docs/CONSTITUICAO.md` §15 pede os 15 pontos abaixo **antes** da implementação,
seguindo o precedente de `design/SOUL_AFFINITY.md` — um documento, não um
checklist embutido no cabeçalho do código (nenhum outro serviço `lab` deste
repositório faz isso; `profession-service.js` explica decisões em prosa, com
referências a `§N`, e é o padrão que `environment-service.js` segue). Este
documento cobre só **Time Sync**. Clima não tem os 15 pontos respondidos
porque não tem implementação — ver `ENVIRONMENT_WEATHER_SPIKE.md`.

## 1. Objetivo

O servidor é a autoridade única de `GameTime`/`TimeScale`. Hoje, sem este
serviço, o relógio de cada cliente Skyrim roda solto: cada instância local
decide sua própria hora, sem correção nem persistência entre restarts do
servidor.

## 2. Problema que resolve

Deriva de relógio entre clientes (cada um vê uma hora diferente, quebrando RP
ambientado — mercado fechado pra um e aberto pra outro) e perda de estado do
mundo a cada restart (o dia/hora "reseta" em vez de continuar de onde parou).

## 3. Problemas que cria

- Um heartbeat rodando dentro do processo do gamemode consome ciclo de CPU e
  I/O de banco continuamente, mesmo com poucos jogadores online — mesma classe
  de custo que `connection-monitor.js` já paga.
- Introduz uma segunda fonte de verdade de tempo (banco vs. GlobalVariable do
  cliente) que precisa ficar sincronizada; se `_applyCorrection` falhar
  silenciosamente (FormDesc errado, ver §9), o servidor pensa que corrigiu e
  não corrigiu.

## 4. Exploits

- Nenhum ganho de gameplay direto: hoje o serviço só sincroniza a hora
  exibida, não altera luz/visibilidade em combate (isso dependeria do clima,
  fora de escopo) nem regras de spawn por horário (não implementado nesta
  fase).
- Se um consumidor futuro ligar mecânica ao horário (ex: loja fecha à noite),
  o vetor de abuso passa a ser manipular o cliente para IGNORAR a correção do
  servidor — mas como a correção aplicada ao cliente é só de
  exibição/GlobalVariable, e qualquer regra de gameplay real precisaria
  consultar `getWorldTime()` no servidor (não no cliente), este serviço já
  nasce com a superfície de abuso fechada: **nenhuma decisão de gameplay deve
  consultar o relógio do cliente, só `environment-service.getWorldTime()` no
  servidor.**

## 5. Impacto econômico

Nenhum hoje — nenhum sistema econômico consulta hora de jogo ainda. Fica
registrado como o ponto de extensão correto para o dia em que precisar (preço
variando por horário, etc.), em vez de cada serviço inventar o próprio
relógio.

## 6. Impacto político

Nenhum — não há decisão de staff nem de facção envolvida no relógio.

## 7. Impacto militar

Nenhum direto. Indireto: se clima algum dia depender deste relógio (ex:
"tempestade só de noite"), o impacto militar herda do clima, não do tempo.

## 8. Impacto religioso

Nenhum sistema de calendário/festival ainda consome `gameDaysPassed`. Ponto de
extensão futuro (feriados, eventos sazonais), não implementado.

## 9. Impacto social

Baixo e indireto: RP ambientado (tavernas fechando à noite, patrulhas
diurnas) fica mais consistente entre jogadores quando todos veem a mesma hora
— mas hoje isso depende de quem narra RP observar `/tempo`, não de mecânica
automática.

## 10. Impacto técnico

- Novo `setInterval` de longa duração dentro do processo do gamemode (ver a
  ressalva sobre §A.6 no cabeçalho de `environment-service.js`).
- Nova tabela de banco de uma linha só, baixo custo de I/O (persistência a
  cada ~30s, não a cada tick).
- Depende de `mp.callPapyrusFunction` contra `GlobalVariable.SetValue`, cujo
  FormDesc **ainda não está confirmado** — ver §14.

## 11. Impacto narrativo

Relógio consistente é pré-requisito silencioso pra qualquer narrativa
ambientada por horário (patrulha muda ao amanhecer, taverna fecha à meia-noite)
— não cria história por si só, mas remove um obstáculo técnico pra quem for
escrever uma.

## 12. Como gera histórias

Não gera diretamente. Habilita: um NPC ou evento futuro que reage à hora do
mundo (ex: "a Guilda dos Ladrões só age depois da meia-noite") passa a ter uma
fonte de verdade confiável para consultar.

## 13. Como é abusado

Ver §4. O caso concreto a vigiar: um consumidor futuro que leia o relógio do
lado do CLIENTE em vez do servidor herdaria a possibilidade de manipulação
local do Skyrim (edição de save, console). A mitigação já está na regra: toda
decisão de gameplay consulta `environment-service.getWorldTime()` no servidor.

## 14. Como balancear

- `INITIAL_TIMESCALE` (`.env`) só vale no primeiro boot — depois disso muda
  via staff/admin action futura (não implementada nesta fase; hoje é fixo no
  banco).
- O heartbeat (`DEFAULT_HEARTBEAT_MS = 2000`) segue o mesmo custo do
  `connection-monitor` — se o servidor crescer e isso pesar, o primeiro
  ajuste é aumentar o intervalo antes de mudar arquitetura.
- **`GlobalVariable.SetValue` não está implementado por este build do SkyMP**
  (`core/skymp-adapter/papyrus-catalog.js`, extraído do C++ upstream — a
  função não consta na lista). Não é uma questão de FormDesc: mesmo com o
  FormDesc certo, a chamada não existiria no VM. `_applyCorrection` detecta
  isso via `isKnownPapyrusFunction` e recusa chamar, avisando uma vez no log
  — nenhum cliente recebe correção de deriva hoje. O relógio autoritativo
  (`getWorldTime()`) continua correto de qualquer forma. Um caminho de
  correção real precisaria de outra abordagem (script Papyrus custom do lado
  do mod, por exemplo) ou de um upstream do SkyMP que implemente a chamada.

## 15. Como integra ao mundo

É infraestrutura, não mecânica — o mesmo enquadramento que
`core/module-registry.js` usa para `interaction`: "sobe cedo, sem gameplay
próprio, para que outros módulos construam em cima". Nasce com
`ENABLE_ENVIRONMENT_SERVICE=false`, como todo módulo `lab` deste projeto —
não muda o mundo até alguém ligar a flag deliberadamente.

## Ressalva de arquitetura — §A.6

`docs/CONSTITUICAO.md` §A.6 pede que "o tick do mundo" rode fora do processo
do SkyMP. A leitura adotada aqui (confirmada com o dono do produto antes da
implementação): §A.6 mira a simulação pesada da §12 (clima → economia → crime
→ política em cascata), não um heartbeat leve de relógio. O heartbeat deste
serviço tem o mesmo perfil de custo do `core/connection-monitor.js`, que já
roda dentro do processo. Se uma fase futura ligar clima→economia de verdade
sobre este relógio, ESSA cadeia — não o relógio em si — precisa sair para um
processo externo.

## Confirmado por teste, não confirmado em sessão real

Mesma ressalva de todo módulo `lab` deste projeto: os testes de
`environment-service.test.js` provam a lógica de avanço/persistência contra um
banco mockado. Ninguém rodou isto num servidor SkyMP real. Diferente da
ressalva usual, aqui uma parte NÃO é "não confirmado ainda" — é confirmado
BLOQUEADO: `_applyCorrection` (§14) nunca vai produzir efeito visível em jogo
enquanto `GlobalVariable.SetValue` não estiver em `papyrus-catalog.js`.
