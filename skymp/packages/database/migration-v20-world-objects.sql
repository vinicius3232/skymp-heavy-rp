-- =============================================================================
-- Migration v20 - Persistencia de estado de celula (world_objects)
-- Aplicar apos migration-v19-game-session-character-bind.sql.
--
-- Cobre item DROPADO (objeto novo, spawnado via ObjectReference.PlaceAtMe —
-- ja aprovado em PAPYRUS_USAGE_POLICY.md, ja usado por market-stalls-service
-- para o marcador visual da barraca). NAO cobre container pre-colocado no
-- mundo (baus/`containers`+`container_inventory`, migration-v2 em diante) nem
-- corpo (`corpse-probe.js` so observa) — essas duas continuam com o proprio
-- modelo, existente, e nao sao duplicadas aqui. Ver
-- docs/technical/HEAVY_RP_GAMEPLAY_SYSTEMS_BACKLOG.md, item 6 do Prototipo
-- da Fase 1.
--
-- `cell_id` no formato FormDesc ("162e2:Skyrim.esm"), nunca "0x...": e' o
-- mesmo formato que `characters.cell_id` e `containers.object_id` ja usam
-- neste banco — um FormID cru nesta coluna erraria em silencio contra o
-- espaco de forms errado (o mesmo defeito de fundo que levou a
-- core/papyrus.js existir).
--
-- `ref_desc` e' NULLABLE de proposito: e' o FormDesc do ObjectReference
-- atualmente spawnado no mundo, e so existe enquanto o servidor estiver de
-- pe com aquela celula reidratada. Depois de um restart, todo `ref_desc`
-- antigo esta morto (PlaceAtMe cria referencia nova a cada chamada) — fica
-- NULL ate a celula ser reidratada de novo. A persistencia real e' pos/rot/
-- estado nesta tabela, nao a referencia em si.
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `world_objects` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `cell_id` VARCHAR(64) NOT NULL COMMENT 'FormDesc da celula, ex: 162e2:Skyrim.esm',
  `base_id` INT NOT NULL COMMENT 'FormID nativo do item/objeto (decimal)',
  `pos_x` FLOAT NOT NULL,
  `pos_y` FLOAT NOT NULL,
  `pos_z` FLOAT NOT NULL,
  `angle_z` FLOAT NOT NULL DEFAULT 0 COMMENT 'Yaw. Mesma convencao de characters.angle_z e market-stalls: so Z importa para objetos soltos no chao',
  `category` VARCHAR(32) NOT NULL COMMENT 'weapon, armor, quest, container_loot, misc — ver CATEGORIES em cell-persistence-service.js',
  `state` VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active, looted, despawned',
  `dropped_by_character_id` INT DEFAULT NULL COMMENT 'Quem largou. NULL = servidor/staff, nao jogador',
  `ref_desc` VARCHAR(64) DEFAULT NULL COMMENT 'FormDesc da referencia viva atual, ou NULL se a celula nao esta reidratada agora',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'NULL = persiste indefinidamente (allowlist). Preenchido = lixo com TTL curto, varrido por sweepExpired()',
  KEY `idx_world_objects_cell` (`cell_id`, `state`),
  KEY `idx_world_objects_expiry` (`expires_at`),
  CONSTRAINT `fk_world_object_dropper` FOREIGN KEY (`dropped_by_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;
