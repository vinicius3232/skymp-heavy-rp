-- v16 - Persistencia do silencio de staff (SV-07)
--
-- Por que esta tabela existe
-- ──────────────────────────
-- Ate aqui o silencio de staff vivia so na memoria do processo. Reiniciar o
-- servidor devolvia a voz de todo mundo — e, desde que a punicao passou a mexer
-- no token do LiveKit (SV-02), um restart nao so devolvia a voz como reemitia
-- tokens com `canPublish: true`. Na pratica, a forma mais barata de escapar de
-- uma punicao era esperar o proximo restart.
--
-- A decisao sobre expiracao, que estava em aberto
-- ───────────────────────────────────────────────
-- `muted_until` NULL significa "ate alguem desfazer". Um valor significa
-- silencio temporario. A expiracao e conferida NA LEITURA, nunca por evento
-- agendado: um job que expira punicoes precisaria rodar, e um job que nao rodou
-- deixaria alguem calado alem da conta sem que ninguem percebesse. Lendo,
-- a punicao expira sozinha mesmo com o servidor desligado no meio.
--
-- Nao ha historico aqui
-- ─────────────────────
-- Uma linha por personagem, substituida a cada nova punicao. O historico de
-- quem calou quem e por que vive no audit log (`moderation_log`), que e o lugar
-- onde ele e imutavel. Guardar historico aqui criaria uma segunda versao da
-- mesma verdade, e duas versoes divergem.

USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `voice_staff_mutes` (
  `character_id` INT NOT NULL,
  `by_character_id` INT NULL COMMENT 'Quem aplicou. NULL = sistema/console.',
  `reason` VARCHAR(255) NOT NULL DEFAULT 'sem motivo registrado',
  `muted_at` BIGINT NOT NULL COMMENT 'epoch ms — mesma unidade do Voice Core, sem conversao de fuso no caminho',
  `muted_until` BIGINT NULL COMMENT 'epoch ms; NULL = ate alguem desfazer',
  PRIMARY KEY (`character_id`),
  KEY `idx_voice_staff_mutes_until` (`muted_until`),
  CONSTRAINT `fk_voice_staff_mutes_character`
    FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
