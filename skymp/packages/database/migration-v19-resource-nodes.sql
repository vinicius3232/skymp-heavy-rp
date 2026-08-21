-- v19 — resource_nodes: o estado persistente do Resource Node Framework
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Escopo desta migration
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Cria SÓ `resource_nodes` — a instância de um nó no mundo (uma veia de
-- minério, uma árvore) e o estado dela (capacidade atual, quando foi
-- atualizada pela última vez). NÃO cria:
--
--   * tabela de "tipo de nó" — `type` é um VARCHAR fechado em código
--     (core/resource-node-registry.NODE_TYPES), mesmo padrão de
--     `crafting_recipes.station_type` e de `character_professions
--     .profession_code`: catálogo fechado, validado em código, sem tabela
--     própria, porque nada nesta fase cria tipo novo em runtime;
--   * sessão de coleta / action token — isso é controle de UMA TENTATIVA de
--     coleta (distância, ferramenta, animação), que pertence à profissão
--     concreta que consome este framework (Minerador etc.), não ao framework
--     genérico;
--   * qualquer coisa de Minerador, Lenhador ou Caçador especificamente.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Por que capacidade não é atualizada por um tick
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `last_updated_at` + `regen_per_hour` são o par que permite calcular a
-- capacidade atual SOB DEMANDA (`elapsed_ms / 3600000 * regen_per_hour`,
-- arredondado para baixo, somado à capacidade gravada, com teto em
-- `max_capacity`) em vez de um job rodando a cada segundo por nó — a mesma
-- escolha que `core/transaction-service.js` já não faz para ouro ("regen" ali
-- nem existe) e que o §26 do briefing de profissões pediu explicitamente
-- ("pode armazenar lastUpdatedAt e calcular regeneração quando node for
-- consultado"). Só `resource-node-service.consume()` GRAVA a capacidade
-- recalculada — uma leitura pura não escreve nada.
--
-- `regen_per_hour` é INTEGER, não FLOAT: o projeto já evita ponto flutuante em
-- contadores de jogo (rank, xp, gold são todos inteiros) pelo mesmo motivo que
-- motivou `MAX_STACK_COUNT`/`MAX_GOLD` em `core/transaction-service.js` —
-- erro de arredondamento em produção é pior que a perda de precisão de "não dá
-- pra regenerar meia unidade por segundo".
--
-- ═══════════════════════════════════════════════════════════════════════════
-- `required_profession`/`required_rank`: por que estes dois entram e
-- `required_tool` não
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A Fase 0 encontrou em `crafting_recipes.requires_perk` um campo lido e
-- NUNCA comparado com nada — uma validação que o cabeçalho do serviço
-- afirmava existir e não existia. Este framework não repete isso:
-- `required_profession`/`required_rank` são de fato checados dentro de
-- `resource-node-service.consume()`, contra `profession-service.js`, porque o
-- framework já tem acesso a ele.
--
-- `required_tool` NÃO entra: "o jogador tem a picareta equipada" exige
-- consultar `Actor.GetItemCount` — Papyrus, ao vivo, contra o cliente — que é
-- exatamente o tipo de checagem que pertence à camada de gameplay concreta
-- (Minerador), não a este framework genérico. Adicionar a coluna agora seria
-- o mesmo erro do `requires_perk`: um campo que nada nesta fase compara.
--
-- ═══════════════════════════════════════════════════════════════════════════

USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `resource_nodes` (
  `id`                    INT AUTO_INCREMENT PRIMARY KEY,

  -- FormDesc do objeto no mundo: hex SEM prefixo, dois-pontos, nome do
  -- arquivo (ex: '162e2:Skyrim.esm') — a convenção documentada no CLAUDE.md
  -- do projeto. Único porque um objeto do mundo só pode ser um nó.
  `form_desc`             VARCHAR(64) NOT NULL COMMENT 'FormDesc do objeto no mundo, ex: 4a2f0:Skyrim.esm',

  -- Categoria fechada em código — core/resource-node-registry.NODE_TYPES.
  `type`                  VARCHAR(16) NOT NULL COMMENT 'ORE, TREE, HERB, CROP, FISHING',

  -- O que este nó entrega por coleta, e quanto.
  `resource_base_id`      INT NOT NULL COMMENT 'FormID nativo do Skyrim entregue via transaction-service.tx',
  `yield_per_action`      INT NOT NULL DEFAULT 1,

  -- Capacidade: o que o nó tem agora (gravado) e o teto (config).
  `max_capacity`          INT NOT NULL,
  `current_capacity`      INT NOT NULL,
  `regen_per_hour`        INT NOT NULL DEFAULT 0 COMMENT 'unidades regeneradas por hora, calculado sob demanda',
  `last_updated_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'ultima escrita de current_capacity — base do calculo de regen',

  -- Gate opcional. NULL = qualquer personagem pode tentar (a checagem de
  -- ferramenta e distância, se existirem, são de quem consome este framework).
  `required_profession`   VARCHAR(32) DEFAULT NULL COMMENT 'codigo de core/profession-registry.js, ou NULL',
  `required_rank`         TINYINT UNSIGNED DEFAULT NULL,

  -- Interruptor administrativo — nó fora de rotação sem apagar histórico.
  `enabled`               TINYINT(1) NOT NULL DEFAULT 1,

  `created_at`            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY `uk_resource_node_form_desc` (`form_desc`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Índices
--
-- `idx_resource_nodes_type` — consulta administrativa ("quantos veios de
-- minério existem?"), barata de deixar pronta agora.
-- `idx_resource_nodes_enabled` — o mesmo, para "quantos nós estão fora de
-- rotação?".
--
-- Nenhum índice de concorrência aqui: `consume()` trava por `id`, chave
-- primária, que já tem índice por construção.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `resource_nodes`
  ADD INDEX IF NOT EXISTS `idx_resource_nodes_type`    (`type`),
  ADD INDEX IF NOT EXISTS `idx_resource_nodes_enabled` (`enabled`);
