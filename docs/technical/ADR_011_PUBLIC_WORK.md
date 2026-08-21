# ADR 011 — Public Work

**Status:** Aceito · **Data:** 20/08/2026 · **Depende de:** ADR 007 · **Revisa:** proposta original de `WORK_ECOSYSTEM_TARGET_ARCHITECTURE.md` §9, que presumia execução síncrona

## Decisão

Public Work é o piso econômico do servidor: sem profissão obrigatória, sem slot de profissão, sem XP profissional, recompensa baixa, cooldown obrigatório.

**Regra fundamental, herdada sem alteração:** Public Work nunca produz diretamente o recurso econômico primário de uma profissão. Minério, madeira comercial e peixe comercial pertencem a Minerador/Lenhador/Pescador — Public Work move, entrega e ajuda, nunca produz.

**Catálogo-alvo (v1, `PublicWorkDefinition`, estático em código):** `hay_delivery`, `firewood_delivery`, `courier_run`, `porter`, `dock_worker`, `supply_runner`, `farm_helper`, `stable_helper`, `caravan_helper`.

**Correção obrigatória desta revisão (item D):** Public Work **não é necessariamente síncrono**. `hay_delivery`/`courier_run`/`supply_runner` têm início e conclusão separados por natureza (busca a carga em A, entrega em B). A execução ganha um modelo persistente mínimo, separado do catálogo:

```
PublicWorkDefinition (estático, em código)   — o quê: tipo de trabalho, origem/destino possíveis, recompensa, cooldown
PublicWorkRun (persistente, tabela nova)     — a instância: quem está fazendo, onde está, desde quando

PublicWorkRun
  id
  character_id
  work_type          → referencia um PublicWorkDefinition
  origin / destination
  status              → 'assigned' | 'in_progress' | 'completed' | 'cancelled' | 'expired'
  started_at / completed_at
  cargo_token         → identifica a carga específica sendo transportada nesta corrida, evita "completar" carga que não foi pega
  request_id          → idempotência — mesma corrida não paga duas vezes
```

## Motivação

Tratar toda execução como síncrona (proposta original) deixaria `hay_delivery` sem onde guardar "já peguei o feno, ainda não entreguei" — abrindo exatamente as classes de exploit que o item D do prompt de revisão nomeou: fake completion (declarar entrega sem ter percorrido origem→destino), double payout (completar a mesma corrida duas vezes), e nenhuma forma de sobreviver a desconexão sem perder ou duplicar a corrida.

## Consequências

- `public-work-service.js` (nome de arquivo a confirmar na implementação) é módulo novo, sucessor de `jobs-service.js` — ver ADR e plano de migração em `WORK_ECOSYSTEM_DECISION_SUMMARY.md`.
- `request_id` é obrigatório em toda chamada que cria ou completa uma `PublicWorkRun`, mesmo padrão de idempotência já usado em `contracts-service.js` (`normalizeIdempotencyKey`) e `core/economy-service.js`.
- Comportamento em restart do servidor: toda `PublicWorkRun` com `status IN ('assigned','in_progress')` na hora do boot é candidata a `expired` por varredura periódica — mesmo padrão de `contracts-service.sweepExpired`/`market-stalls-service` (timer de expiração). Isto formaliza a exigência do prompt ("definir comportamento em restart") sem inventar mecanismo novo — reaproveita o padrão já usado duas vezes no projeto.
- Cancelamento: jogador ou sistema pode mover `PublicWorkRun` de `assigned`/`in_progress` para `cancelled` — nenhum pagamento ocorre nessa transição, mesmo princípio de `contracts-service.cancel()`.
- Validação de cargo/rota/destino acontece na transição para `completed`, não na criação — o servidor confirma no fim, não confia na declaração do cliente no início (mesma disciplina de "client-trusted só para iniciar" já usada em `mining-service.js`).
- O catálogo (`PublicWorkDefinition`) permanece estático em código nesta fase — mesma decisão já tomada para `core/profession-registry.js` e `core/resource-node-registry.js`: catálogo pequeno e estável é decisão de design, não dado editável em produção.

## Alternativas rejeitadas

- **Execução 100% síncrona (proposta original desta arquitetura).** Rejeitada nesta revisão — não sobrevive a disconnect/reconnect nem previne fake completion para trabalhos com origem/destino.
- **`PublicWorkRun` guardando o catálogo inteiro por linha (duplicando `PublicWorkDefinition`).** Rejeitada — seria a mesma duplicação de fonte de verdade que este documento evita em outros pontos; `PublicWorkRun` referencia `work_type`, não copia os dados da definição.
- **Tabela `public_work_catalog` dinâmica.** Rejeitada, mantendo a decisão da arquitetura-alvo anterior — catálogo de ~9 itens não justifica edição em produção nesta fase.
