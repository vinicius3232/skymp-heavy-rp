-- v20 — crafting_recipes: gate de profissão/rank
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Por que isto entra, e por que não é `requires_perk` de novo
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `crafting_recipes.requires_perk` é o campo que a Fase 0 encontrou lido em
-- `listRecipes` e NUNCA comparado com nada — uma validação que o cabeçalho do
-- serviço afirmava existir e não existia (ver o cabeçalho de
-- crafting-service.js e docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md §11).
-- Esta migration não repete o erro: `required_profession`/`required_rank` são
-- checados dentro de `crafting-service.craftItem()` antes de qualquer
-- consumo, no mesmo desenho que `resource_nodes.required_profession` já usa
-- contra `profession-service.js` (ver migration-v19-resource-nodes.sql).
--
-- `required_perk` continua sem uso — não é escopo desta migration mexer nele,
-- só documentar que o padrão novo (checado de verdade) é este, não aquele.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Por que a coluna é por RECEITA, não por `station_type`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Duas receitas na mesma forja podem exigir profissões diferentes (uma
-- ferradura simples vs. uma espada élfica), e `alchemy_lab` não tem profissão
-- correspondente no catálogo hoje (core/profession-registry.js não tem
-- `alchemist`) — então NULL por receita, e não um mapa fixo station→profissão
-- em código, é o que deixa `alchemy_lab` sem gate sem precisar de exceção.
--
-- ═══════════════════════════════════════════════════════════════════════════

USE `skymp_rp`;

ALTER TABLE `crafting_recipes`
  ADD COLUMN IF NOT EXISTS `required_profession` VARCHAR(32) DEFAULT NULL
    COMMENT 'codigo de core/profession-registry.js, ou NULL para receita livre',
  ADD COLUMN IF NOT EXISTS `required_rank` TINYINT UNSIGNED DEFAULT NULL;
