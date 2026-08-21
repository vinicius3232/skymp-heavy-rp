-- =============================================================================
-- Migration v19 - Bind de personagem na game session (AUTH-003 / CHR-001)
-- Aplicar apos migration-v18-professions.sql.
--
-- Fecha o SECURITY-BLOCKER AUTH-03 (docs/technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md):
-- a sessao autenticava a CONTA, mas nao fixava qual personagem — o gamemode
-- escolhia com `ORDER BY id DESC LIMIT 1` toda vez que alguem conectava. Ate
-- CHR-002 (selecao explicita, multiplos approved por conta) so existe UM
-- personagem approved por conta, entao o bind e automatico: `apps/game-api`
-- resolve o personagem approved da conta no momento da admissao na fila —
-- mesmo instante em que consome o `launch_grant`, nao depois da promocao —
-- e grava aqui. O gamemode passa a ler daqui em vez de re-escolher sozinho.
--
-- Quando CHR-002 chegar e uma conta puder ter mais de um approved, a escolha
-- vira input do jogador no mesmo ponto de bind; a coluna e a query no
-- gamemode nao mudam, so a origem do characterId muda.
--
-- `character_id` e NULLABLE de proposito: sessoes emitidas antes desta
-- migration nao tem bind e continuam validas ate expirar (TTL de horas, nao
-- dias) — nao ha necessidade de backfill, elas se resolvem sozinhas.
-- `ON DELETE SET NULL` porque um personagem retirado (`status='retired'`, ver
-- CONTRIBUTING.md — nunca DELETE em personagem) nunca aciona isto na pratica;
-- e defensivo, nao expectativa.
-- =============================================================================
USE `skymp_rp`;

ALTER TABLE `game_sessions`
  ADD COLUMN IF NOT EXISTS `character_id` INT NULL AFTER `account_id`,
  ADD COLUMN IF NOT EXISTS `bound_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Quando o personagem foi vinculado — no join da fila, nao na conexao' AFTER `character_id`;

ALTER TABLE `game_sessions`
  ADD CONSTRAINT `fk_game_session_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL;

-- A leitura mais comum e "qual e o personagem da sessao ativa mais recente
-- desta conta" (whitelist.js). expires_at ja tem indice via
-- idx_game_session_account; account_id sozinho basta para o filtro adicional
-- de character_id IS NOT NULL, e reaproveita o mesmo indice composto — nao
-- precisa de um terceiro.
