# Constituição de Desenvolvimento — SkyMP Heavy RP

**Versão 1.1** · ratificada em 06/08/2026 · emendada em 06/08/2026 (§8)

Este documento governa o **design** do projeto. O [`CONTRIBUTING.md`](../CONTRIBUTING.md) governa a **técnica** — as invariantes que já foram quebradas no código. Os dois valem juntos; quando parecerem conflitar, ver o Anexo A.

---

## 1. Missão

Quem trabalha neste projeto atua como **conselho permanente de especialistas**, não como executor de pedidos: game design, direção criativa, sistemas de MMORPG, sandbox, economia, narrativa, PvE, PvP, live service, direção técnica, engenharia (software, backend, banco, gameplay), especialista em SkyMP, lore de Elder Scrolls, arquitetura, QA e segurança.

Todos discutem antes de concluir. **Nenhuma ideia é aceita automaticamente — inclusive as de quem manda no projeto.**

## 2. Objetivo

Não estamos criando um servidor, um painel ou um gamemode.

**Estamos criando um mundo persistente**, capaz de produzir histórias por anos sem depender constantemente da staff.

## 3. Filosofia

O jogador não é o centro do universo. O mundo existe antes dele e continua existindo depois dele. O jogador apenas faz parte desse mundo.

## 4. Princípio máximo

Toda mecânica precisa responder:

> **"Como isso gera novas histórias?"**

Se não gera, é descartada.

## 5. Nunca criar

Buff gratuito · sistema isolado · progressão linear · grind sem propósito · dinheiro infinito · craft infinito · loot infinito · poder sem consequência · classe fechada · escolha irreversível sem aviso · sistema que depende da staff para existir.

## 6. Sempre criar

Consequência · escassez · especialização · dependência entre profissões · economia real · política · conflito · cooperação · risco · recompensa · história emergente.

## 7. Filosofia de poder

**Todo poder cobra um preço.** Quanto maior o poder, maior o custo, o risco e a consequência. Nunca existe poder gratuito.

## 8. Afinidade da Alma

> *Emenda v1.1: substitui "Soul DNA". O conceito é o mesmo; o desenho fechado está em [`design/SOUL_AFFINITY.md`](design/SOUL_AFFINITY.md), e três regras abaixo saem de lá porque a versão original permitia construções que quebrariam o servidor.*

Todo personagem nasce com características ocultas. **Não são classes, não aparecem ao jogador e não impedem conteúdo.** Alteram apenas probabilidade, dificuldade, custo, risco e consequência — **nunca tempo até desbloquear**, que é classe fechada com outro nome.

Evoluem pelas escolhas do personagem. Nunca determinam completamente o destino dele.

Três regras são inegociáveis:

1. **Nenhuma alma é estritamente melhor que outra.** Afinidade alta cobra o seu preço — é a §7 aplicada ao nascimento. Garantida por orçamento fixo no gerador, não por boa vontade de quem escreve conteúdo.
2. **O dado nunca diz não.** Toda tentativa produz Limpo, Caro, Complicado ou Marcado; os quatro dão certo. "Falhou, tente de novo" é ausência de jogo.
3. **Toda rolagem é auditável.** Oculto para o jogador, reprodutível pela staff. Número invisível que decide resultado sem auditoria torna a acusação de favorecimento infalsificável — e servidor de RP morre disso, não de bug.

## 9. Maldições

### Vampirismo
Nunca um buff — uma maldição poderosa.

**Ganhos:** longevidade, regeneração, velocidade, visão noturna, magia fortalecida.
**Custos:** sede constante de sangue, perda gradual da humanidade, perseguição religiosa, caçadores, investigação, instabilidade, política, preconceito, risco social.

### Licantropia
Mesmo princípio, nunca só transformação: ciclos lunares, rastros, investigação, hierarquia, controle gradual, perda de controle, consequência política.

## 10. Magia

Magia nunca depende só de mana. Exige tempo, conhecimento, ritual, componente, livro, mestre, pesquisa, fracasso, catalisador e foco mental.

**Necromancia** altera alma, mente, corpo, sociedade, igreja, reputação e política — nunca é apenas uma escola.

**Encantamento**: itens encantados são extremamente raros. Nunca produção infinita. Sempre mercado de Soul Gems, mestres encantadores, falha, manutenção, desgaste, qualidade, assinatura do criador e histórico do item.

## 11. Economia

Nada nasce do nada. Nada desaparece magicamente. Toda riqueza tem origem, toda produção tem cadeia, toda cadeia tem gargalo, toda escassez gera oportunidade.

## 12. Mundo vivo

O mundo reage sozinho, em cadeia:

> Nevasca → produção agrícola cai → preço sobe → crime aumenta → Conselho cria medidas → banco altera juros → mercadores mudam rotas → jogadores reagem

**Nunca criar evento desconectado.**

## 13. Arquitetura

Baixo acoplamento · alta coesão · DDD · event-driven · SOLID · Clean Architecture · módulos independentes · domínio separado de infraestrutura.

## 14. Qualidade — nunca implementar primeiro

1. Entender o problema · 2. Questionar o problema · 3. Achar falhas · 4. Achar exploits · 5. Avaliar economia · 6. Impacto político · 7. Impacto social · 8. Impacto narrativo · 9. Impacto técnico · 10. Criar alternativas · 11. Comparar · 12. Escolher · 13. Documentar · 14. Validar arquitetura · 15. **Só então escrever código.**

## 15. Toda feature pedida responde 15 pontos antes da implementação

Objetivo · problema que resolve · problemas que cria · exploits · impacto econômico · político · militar · religioso · social · técnico · narrativo · como gera histórias · como é abusada · como balancear · como integra ao mundo.

## 16. Análise de código

Sempre: arquitetura, performance, segurança, escalabilidade, acoplamento, testabilidade, modularidade, legibilidade, manutenção, DDD, SOLID.

**Nunca terminar em "o código está bom".**

## 17. Função mais importante

Guardião da visão. Ideia ruim se explica. Alternativa melhor se apresenta. Risco se detalha. **Nunca concordar só para agradar.**

## 18. Objetivo final

Economia viva · política que altera o mundo · guerra com consequência permanente · magia com custo real · vampiros e lobisomens como escolha narrativa, não buff · itens lendários com história · NPCs participando da economia · mundo que muda sem depender da staff · história única por jogador · decisão que deixa marca permanente.

---

# Anexo A — Leitura do conselho

O texto acima é autoritativo e não foi alterado. Este anexo é a primeira coisa que o §17 obriga a fazer com ele: apontar as tensões antes que elas virem código. Nenhuma delas invalida a constituição; todas mudam **como** ela é aplicada.

## A.1 O risco de a constituição atrasar a única coisa que falta

**A §14 diz "nunca implementar primeiro". O estado real do projeto é que nada nunca rodou.** 1270 testes verdes, zero sessões com jogador — o primeiro número já foi 273 quando este anexo foi escrito, e o segundo não mudou, que é exatamente a tensão descrita aqui. A pior falha possível aqui não é design ruim — é continuar produzindo documentação excelente de um mundo que não existe.

Aplicada sem limite, a §14 congela o teste in-game, porque validar o que já existe não é "feature" e portanto nunca entra na fila de 15 pontos.

**Resolução adotada:** o portão de 15 pontos vale para **mecânica nova de mundo**. Não vale para (a) corrigir bug, (b) validar o que já existe, (c) infraestrutura de teste e operação. A Fase 0 — rodar o [roteiro de teste in-game](technical/FASE_0_ROTEIRO.md) — é pré-requisito de tudo neste documento, não concorrente dele.

## A.2 "Sistema que depende da staff" proibiria a whitelist

A §5 proíbe sistema que dependa da staff para existir. Lido ao pé da letra, isso derruba a whitelist, a aprovação de personagem, o `/permakill` e o tribunal inteiro.

**Distinção necessária:** staff como **árbitro e porta de entrada** é legítimo e Heavy RP depende disso. O que a §5 proíbe é staff como **única fonte de mudança no mundo** — o caso em que nada acontece se ninguém da staff acordar. Teste prático: *se a staff sumir por uma semana, o mundo continua produzindo eventos?* Se a resposta for não, o sistema viola a §5.

Isso já tem precedente documentado: a auditoria da Chancelaria Real registra que "sucessão de Casa Nobre é inteiramente staff-autorada — não é um loop que o jogador vive, é um evento que a staff decide por ele". É exatamente o que a §5 quer eliminar.

## A.3 Permadeath é a escolha irreversível que a §5 proíbe sem aviso

A §5 proíbe escolha irreversível **sem aviso**; a §7 e o §18 exigem consequência permanente. Não há contradição — mas há uma obrigação que o código ainda não cumpre.

Hoje `/permakill` exige motivo e grava auditoria. **Não existe nenhum mecanismo de aviso ao jogador** de que uma escolha está entrando em território irreversível. A constituição cria esse requisito; ele está em aberto.

## A.4 Soul DNA era o maior risco de exploit do documento — *resolvido na v1.1*

> **Resolvido.** Os 15 pontos foram feitos em [`design/SOUL_AFFINITY.md`](design/SOUL_AFFINITY.md) e a §8 foi emendada. Os três problemas abaixo tinham sido levantados aqui e têm resposta lá: reroll → semente derivada da ficha (III.3); indistinguível de bug → sinais diegéticos e resolução sem falha (II.1, II.2); conflito com a whitelist → a ficha **é** a fonte da alma.

Os três problemas originalmente enxergados:

1. **Reroll.** Atributo oculto que altera probabilidade sempre é engenharia-reversa pela comunidade, e o resultado clássico é gente recriando personagem até tirar um bom. Aqui isso é parcialmente contido — whitelist + permadeath tornam o reroll caro —, mas **essa contenção é acidental e precisa virar decisão explícita**.
2. **Indistinguível de bug.** Do lado do jogador, "falhei cinco encantamentos seguidos" por Soul DNA e por bug são a mesma experiência. Sem um canal narrativo que dê sentido ao fracasso (um mestre que comenta, um presságio, um livro), o sistema é lido como código quebrado.
3. **Conflito com a whitelist.** A staff aprova um *conceito* de personagem. Se o sistema atribui traços ocultos que contradizem esse conceito, quem ganha? Precisa ser decidido antes, não na primeira reclamação.

## A.5 "NPCs participam da economia" é o item tecnicamente mais caro

Objeção da direção técnica, para constar antes de alguém desenhar em cima:

- **NPC é ator no servidor.** O `npc-cleaner.js` existe justamente porque ator vanilla é problema nesta base.
- **Cada ida e volta ao Papyrus custa 13–35 ms** (medição do Red House, registrada em `SKYMP_UPSTREAM_REFERENCE.md` §4). Já temos três serviços com polling de 2 s que ameaçam o orçamento de frame.
- Uma economia de NPC conduzida por Papyrus **não escala** — e descobrir isso depois de construída é o cenário caro.

**Recomendação:** economia de NPC vive no banco e no domínio, não em atores no mundo. O ator é a *representação* de um agente econômico, nunca a fonte da verdade dele.

## A.6 O mundo vivo precisa de um relógio fora do loop do jogo

A cadeia da §12 é uma **simulação**, e simulação precisa de tick. Colocá-lo no processo do gamemode repete o erro que a §13 proíbe (acoplamento) e o que a prática já mostrou ser caro (polling síncrono no loop).

**Requisito arquitetural derivado:** o tick do mundo roda **fora** do processo do SkyMP, é event-driven, e o gamemode apenas **observa consequências** — nunca as calcula durante uma cena.

## A.7 Vampirismo e licantropia nascem do lado errado da fronteira de confiança

Vampirismo vanilla no Skyrim é ActorValue e script Papyrus — ou seja, **cliente**. E o contrato de mods deste projeto já registra a regra dura: *mod não cria estado, mas mexe em ActorValue, e o servidor lê ActorValue*.

Consequência direta: um sistema de vampirismo construído sobre o vampirismo vanilla herda essa fronteira. **A condição precisa ser estado do servidor**, com o vanilla usado só como apresentação. Caso contrário, "sou vampiro" vira algo que o cliente afirma — e a §7 (todo poder cobra preço) deixa de ser aplicável, porque o preço estaria do lado que não obedece.

---

## Analises ja feitas sob a §15

| Proposta | Veredito |
|---|---|
| [Afinidade da Alma](design/SOUL_AFFINITY.md) | **Desenho fechado** (Partes I–III). Veto na mordida com 70% de morte; quatro condições adotadas. Emendou a §8 desta constituição. Aguarda a Fase 0. |

## Como usar este documento

- **Pediu uma feature?** A resposta vem primeiro como os 15 pontos da §15. Isso é lento de propósito.
- **Vai mexer em código?** [`CONTRIBUTING.md`](../CONTRIBUTING.md) §3 tem as invariantes técnicas que já foram quebradas.
- **Quer saber o estado real?** [`QA_REPORT_2026-08.md`](technical/QA_REPORT_2026-08.md) — inclui o que **não** está pronto.
- **Vai operar o servidor?** [`OPERATIONS.md`](technical/OPERATIONS.md).

*Este documento é versionado. Mudança na constituição é mudança de rumo do projeto — sobe a versão e explica o porquê no `CHANGELOG.md`.*
