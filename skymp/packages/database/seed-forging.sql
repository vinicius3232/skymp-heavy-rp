-- seed-forging.sql
-- Receitas baseadas nos mods Ars Metallica e Cloaks & Capes
--
-- `required_profession` preenchido em 20/08/2026, depois de
-- migration-v20-crafting-profession-gate.sql adicionar a coluna e
-- crafting-service.craftItem() passar a checá-la de verdade. Mapeamento por
-- RECEITA (não por `station_type`): 1001/1002 derretem sucata em lingote —
-- trabalho de Fundidor (`smelter`), não de Ferreiro (`blacksmith`), embora as
-- duas rodem na mesma `forge`. 1003 é curtume — `tanner`.
--
-- ⚠️ Não existe aqui nenhuma receita de FORJAR arma/armadura a partir de
-- lingote — a que daria trabalho de verdade ao `blacksmith`. Adicionar uma
-- exigiria um `result_base_id` real de arma/armadura do mod em uso, e este
-- arquivo já tem o precedente do que dá errado ao inventar FormID: a linha
-- 1003 abaixo usa `999999` de placeholder desde a versão anterior, porque
-- ninguém confirmou o FormID real da capa do Cloaks & Capes. Uma receita de
-- Ferreiro nova fica para quem tiver o FormID confirmado — não é este commit.

USE skymp_rp;

-- Derreter Armadura de Ferro (Gera 2 Lingotes de Ferro) — Fundidor
INSERT INTO crafting_recipes (id, name, station_type, result_base_id, result_count, requires_perk, required_profession, required_rank)
VALUES (1001, 'Derreter: Armadura de Ferro', 'forge', 371940, 2, NULL, 'smelter', NULL)
ON DUPLICATE KEY UPDATE required_profession = VALUES(required_profession);

INSERT INTO crafting_ingredients (recipe_id, base_id, count)
VALUES (1001, 77385, 1) -- 1x Iron Armor
ON DUPLICATE KEY UPDATE count=count;

-- Derreter Espada de Aço (Gera 1 Lingote de Aço) — Fundidor
INSERT INTO crafting_recipes (id, name, station_type, result_base_id, result_count, requires_perk, required_profession, required_rank)
VALUES (1002, 'Derreter: Espada de Aço', 'forge', 371941, 1, NULL, 'smelter', NULL)
ON DUPLICATE KEY UPDATE required_profession = VALUES(required_profession);

INSERT INTO crafting_ingredients (recipe_id, base_id, count)
VALUES (1002, 80265, 1) -- 1x Steel Sword
ON DUPLICATE KEY UPDATE count=count;

-- Criar Capa de Couro (Simulação Cloaks and Capes) — Curtidor
INSERT INTO crafting_recipes (id, name, station_type, result_base_id, result_count, requires_perk, required_profession, required_rank)
VALUES (1003, 'Capa de Couro (Cloaks & Capes)', 'tanning_rack', 999999, 1, NULL, 'tanner', NULL) -- Substituir 999999 pelo formId real da capa gerado pelo mod
ON DUPLICATE KEY UPDATE required_profession = VALUES(required_profession);

INSERT INTO crafting_ingredients (recipe_id, base_id, count)
VALUES (1003, 898514, 3) -- 3x Couro (Leather)
ON DUPLICATE KEY UPDATE count=count;
