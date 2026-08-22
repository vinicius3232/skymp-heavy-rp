-- v18 — character_professions: o estado persistente do Profession Core
--
-- ═══════════════════════════════════════════════════════════════════════════
-- O que esta migration cria, e o que ela deliberadamente NÃO cria
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Cria SÓ `character_professions`. O briefing original (§3) sugeria também uma
-- tabela `professions` (id, code, name, category, enabled) para o catálogo.
-- Ela não entra aqui, e a omissão é uma decisão, não um esquecimento:
--
--   * As treze profissões são fixas em código (core/profession-registry.js) e
--     nada nesta fase permite criar profissão nova em runtime — não existe
--     admin action, painel nem comando para isso. Uma tabela sem escritor além
--     de uma migration de seed seria puro espelho do registry, sem nenhum grau
--     de liberdade a mais.
--   * O projeto já tem o precedente exato para "catálogo fechado, validado em
--     código, sem tabela própria": `crafting_recipes.station_type` é
--     `VARCHAR(64)` com a lista de valores no COMMENT, não uma FK para uma
--     tabela `crafting_stations`. `character_professions.profession_code`
--     segue o mesmo padrão abaixo.
--   * O próprio §3 do briefing pede "avaliar necessidade real" antes de criar
--     tabela — aplicado à risca aqui, não só ao `ProfessionRank` que o texto
--     cita como exemplo.
--
-- Se uma fase futura permitir profissão customizada por servidor (fora do
-- código), a tabela `professions` volta a fazer sentido — e essa migration
-- não impede isso: `profession_code` continua sendo só um VARCHAR.
--
-- Nenhuma tabela de rank, XP-curve, ResourceNode, contrato ou crafting entra
-- aqui — pertencem às fases seguintes (Resource Node Framework em diante).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Por que UMA tabela, com status, e não INSERT/DELETE por concessão
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `status` distingue active/suspended/revoked em vez de a linha existir ou não,
-- porque revogar uma profissão APAGANDO a linha perderia rank e XP em silêncio
-- — o §8 do briefing pede history preservada. A UNIQUE de
-- `(character_id, profession_code)` é o que torna "conceder de novo uma
-- profissão revogada" um UPDATE que reaproveita a linha (e o rank/XP antigos),
-- em vez de precisar de uma segunda linha para o mesmo par.
--
-- ═══════════════════════════════════════════════════════════════════════════

USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `character_professions` (
  `id`                       INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`             INT NOT NULL,

  -- Catálogo fechado em código, não em banco — ver o comentário acima.
  -- Validado por core/profession-registry.js antes de qualquer escrita aqui.
  `profession_code`          VARCHAR(32) NOT NULL COMMENT 'codigo do catalogo, ver skymp/gamemode/core/profession-registry.js',

  `status`                   VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active, suspended, revoked',

  -- Numérico e sem label universal de propósito (§9 do briefing): rank 0..N,
  -- cada profissão pode um dia ter os próprios rótulos (Aprendiz/Mestre/...)
  -- fora do banco. O teto de hoje é a opção `profession.maxRank`
  -- (core/server-options.js), não uma CHECK constraint — o MySQL deste projeto
  -- não usa CHECK em nenhuma outra tabela, e a validação de faixa já é feita em
  -- profession-service.js antes do UPDATE.
  `rank`                     TINYINT UNSIGNED NOT NULL DEFAULT 0,

  -- Contador cru, sem curva de nível (§10 do briefing: "NAO implementar curva
  -- de level-up complexa nesta fase"). UNSIGNED porque profession-service.js
  -- nunca escreve XP negativo — o piso é sempre aplicado em código antes do
  -- UPDATE, então a coluna não precisa admitir negativo.
  `xp`                       INT UNSIGNED NOT NULL DEFAULT 0,

  -- Quem concedeu (ou reativou) a profissão. NULL é legítimo — não existe hoje
  -- caminho que conceda sem staff, mas a coluna não deve exigir um valor que um
  -- caminho futuro (ex: PNJ de guilda) talvez não tenha.
  `granted_by_character_id`  INT DEFAULT NULL,

  `joined_at`                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- A restricao que impede o duplicado do §7 do briefing ("mesmo character +
  -- mesma profession + duplicados"), e o que torna reconceder uma profissao
  -- revogada um UPDATE em vez de um segundo INSERT.
  UNIQUE KEY `uk_character_profession` (`character_id`, `profession_code`),

  CONSTRAINT `fk_charprof_character`   FOREIGN KEY (`character_id`)            REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_charprof_granted_by`  FOREIGN KEY (`granted_by_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Índices
--
-- `idx_charprof_character` é o que a query de concorrência de
-- `grantProfession`/`reactivateProfession` usa (`SELECT ... WHERE character_id
-- = ? AND status = 'active' FOR UPDATE`): sob REPEATABLE READ (padrão do
-- InnoDB), esse SELECT com FOR UPDATE toma next-key lock sobre a faixa do
-- índice, o que serializa duas concessões concorrentes para o MESMO
-- personagem — é o que impede o personagem passar de
-- `profession.maxPerCharacter` sob corrida (§25 do briefing).
--
-- `idx_charprof_status` serve consulta administrativa futura ("quantos
-- mineradores ativos existem?"), que ainda não existe nesta fase mas é barata
-- de já deixar pronta.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `character_professions`
  ADD INDEX IF NOT EXISTS `idx_charprof_character` (`character_id`),
  ADD INDEX IF NOT EXISTS `idx_charprof_status`    (`status`);
