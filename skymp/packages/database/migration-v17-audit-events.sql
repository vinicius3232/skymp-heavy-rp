-- v17 — audit_events: a auditoria sai de dentro do fluxo de evento de jogo
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Por que esta tabela existe, medido antes de escrita nenhuma
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `audit_logs` tem seis colunas e recebe TREZE escritores que não gravam a
-- mesma coisa: ação de staff, decisao de acesso, fala de RP, episodio de
-- combate, rolagem de alma e evento de interacao, todos na mesma pilha. E
-- `details TEXT` carrega tres formatos ao mesmo tempo — texto livre
-- `chave=valor`, JSON puro, e o `chave=valor` do pipeline.
--
-- O efeito nao e estetico. `GET /api/audit` faz
-- `ORDER BY created_at DESC LIMIT 200`, e `rp_chat:*` grava UMA LINHA POR FALA
-- de cada jogador. Com o servidor cheio, as 200 linhas mais recentes sao
-- conversa de taverna e a ultima acao de staff sai da tela em minutos — sem
-- nada quebrar, sem erro, sem ninguem perceber.
--
-- Nenhum indice conserta isso: o filtro que separaria os dois e justamente o
-- que a tabela nao tem. `action LIKE 'staff:%'` nao usa
-- `idx_audit_action_created` como igualdade, e nao existe coluna de categoria.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- O que esta migration NAO faz
-- ═══════════════════════════════════════════════════════════════════════════
--
--   * NAO altera `audit_logs`. Nenhum `ALTER`, nenhum `DROP`, nenhuma coluna
--     nova. A tabela antiga continua exatamente como esta.
--   * NAO apaga linha nenhuma. O backfill COPIA.
--   * NAO move evento de jogo. `rp_chat`, `combat`, `death`, `soul` e
--     `interaction` continuam em `audit_logs`, que passa a ser o fluxo de
--     evento de jogo. Move-los exige decidir retencao e particionamento, e
--     isso e uma rodada propria.
--
-- Consequencia pratica: aplicar esta migration NAO pode quebrar nada que le
-- `audit_logs` hoje, porque ela nao toca em nada que existe. E ela e
-- reexecutavel — `CREATE TABLE IF NOT EXISTS` mais um `INSERT ... SELECT` com
-- chave unica no id de origem.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Sobre JSON: o que e coluna e o que nao e
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Campo que aparece em `WHERE` vira COLUNA com indice. Campo de forma variavel
-- — `before`, `after`, `metadata` — vira JSON, porque cada acao guarda coisa
-- diferente e uma coluna por chave seria uma tabela que muda a cada acao nova.
--
-- Guardar tudo em JSON teria sido mais rapido de escrever e teria repetido o
-- defeito de `details`: buscar por staff, por periodo ou por severidade viraria
-- varredura de tabela com extracao de JSON por linha.
--
-- ═══════════════════════════════════════════════════════════════════════════

USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `audit_events` (
  `id`                   BIGINT AUTO_INCREMENT PRIMARY KEY,

  -- Identidade do evento. `event_id` e por invocacao; `correlation_id` liga
  -- invocacoes relacionadas (o retry de um clique, a mesma decisao
  -- atravessando painel e jogo). Ver core/admin-action.js.
  `event_id`             VARCHAR(64)  NOT NULL,
  `correlation_id`       VARCHAR(128) DEFAULT NULL,

  -- DATETIME(3) e nao TIMESTAMP: `TIMESTAMP` no MySQL/MariaDB e convertido
  -- entre fusos na leitura e na escrita conforme `time_zone` da SESSAO. Quatro
  -- processos e um cliente MySQL com fuso diferente produziriam uma linha do
  -- tempo que nao fecha — que e a unica coisa que uma auditoria precisa fazer.
  -- Milissegundos porque duas acoes de staff no mesmo segundo precisam ter
  -- ordem definida numa arbitragem.
  `occurred_at`          DATETIME(3)  NOT NULL,

  `session_id`           VARCHAR(128) DEFAULT NULL,

  -- Quem agiu e contra quem. Os quatro sao coluna, e nao JSON, porque sao a
  -- pergunta mais frequente de qualquer investigacao.
  --
  -- Sem FOREIGN KEY de proposito. `ON DELETE CASCADE` num registro de auditoria
  -- significa que apagar uma conta apaga a prova do que ela fez — e
  -- `ON DELETE SET NULL` apaga contra quem. O projeto ja decidiu que personagem
  -- nunca e apagado (`status='retired'`), mas a auditoria nao pode depender
  -- dessa disciplina para sobreviver.
  `staff_account_id`     INT          DEFAULT NULL,
  `staff_character_id`   INT          DEFAULT NULL,
  `target_account_id`    INT          DEFAULT NULL,
  `target_character_id`  INT          DEFAULT NULL,

  -- Classificacao. `category` e o dominio da acao (`players`, `economy`, …);
  -- `severity` distingue o reversivel do irreversivel; `outcome` diz se
  -- aconteceu. Os tres sao fechados no catalogo (core/audit-event.js).
  `category`             VARCHAR(32)  NOT NULL,
  `action`               VARCHAR(96)  NOT NULL,
  `severity`             VARCHAR(16)  NOT NULL DEFAULT 'info',
  `outcome`              VARCHAR(16)  NOT NULL DEFAULT 'executed',
  `source`               VARCHAR(16)  NOT NULL DEFAULT 'unknown',

  -- A capability exigida. Coluna e nao metadata: "quem usou `identity.reveal`?"
  -- e uma pergunta de seguranca, nao um detalhe da acao.
  `permission`           VARCHAR(64)  DEFAULT NULL,

  -- Texto livre, mas com teto. `details TEXT` sem limite foi onde tres formatos
  -- passaram a conviver.
  `reason`               VARCHAR(512) DEFAULT NULL,

  -- Forma variavel por acao. `before`/`after` respondem "o que mudou"; hoje so
  -- `setGold` grava algo equivalente, e por convencao de um autor dentro de
  -- texto livre.
  --
  -- `before` e `after` NAO podem ser os nomes das colunas: `BEFORE` e palavra
  -- reservada no MySQL (gatilhos). O sufixo `_state` e o preco disso.
  `before_state`         JSON         DEFAULT NULL,
  `after_state`          JSON         DEFAULT NULL,
  `metadata`             JSON         DEFAULT NULL,

  -- De onde a linha veio quando ela e copia. NULL = nasceu aqui.
  -- E o que torna o backfill reexecutavel sem duplicar.
  `legacy_audit_log_id`  INT          DEFAULT NULL,

  `created_at`           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY `uk_audit_event_id` (`event_id`),
  UNIQUE KEY `uk_audit_legacy`   (`legacy_audit_log_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indices
--
-- Um por eixo de busca pedido, todos terminando em `occurred_at` porque toda
-- consulta de auditoria e ordenada no tempo: sem a coluna de tempo no fim do
-- indice, o MySQL filtra pelo indice e ordena em disco.
--
-- Sao nove indices secundarios, e o custo e real: cada `INSERT` os atualiza.
-- Aceito porque esta tabela e escrita uma vez por ACAO ADMINISTRATIVA — dezenas
-- por dia, nao milhares por minuto como `rp_chat` —, e porque uma auditoria que
-- nao se consulta em tempo util nao serve para arbitrar nada.
--
-- Criados em `ALTER` separado do `CREATE` para que a migration seja aplicavel
-- em banco que ja tenha a tabela de uma execucao parcial anterior.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `audit_events`
  ADD INDEX IF NOT EXISTS `idx_audit_ev_time`        (`occurred_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_ev_staff`       (`staff_account_id`, `occurred_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_ev_staff_char`  (`staff_character_id`, `occurred_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_ev_target`      (`target_account_id`, `occurred_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_ev_target_char` (`target_character_id`, `occurred_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_ev_action`      (`action`, `occurred_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_ev_category`    (`category`, `occurred_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_ev_severity`    (`severity`, `occurred_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_ev_session`     (`session_id`, `occurred_at`),
  ADD INDEX IF NOT EXISTS `idx_audit_ev_correlation` (`correlation_id`);

-- ═══════════════════════════════════════════════════════════════════════════
-- Backfill
--
-- COPIA de `audit_logs` as linhas que sao AUDITORIA. Nada e apagado, nada e
-- movido, e evento de jogo fica onde esta.
--
-- `INSERT IGNORE` mais `uk_audit_legacy` tornam a operacao reexecutavel: rodar
-- duas vezes nao duplica. Isso importa porque as migrations deste projeto sao
-- aplicadas A MAO, e um banco meio-migrado e a falha mais cara que ele tem.
--
-- A classificacao abaixo espelha `classifyLegacyAction()` em
-- core/audit-event.js. As duas precisam concordar, e ha teste que compara — se
-- divergirem, o backfill classifica uma coisa e o codigo classifica outra sobre
-- a MESMA linha.
--
-- O `details` original vai inteiro para `metadata.legacy_details`. Ele e texto
-- livre em tres formatos e nao da para reparti-lo em colunas com confianca; o
-- que da para fazer com honestidade e preserva-lo verbatim e dizer de onde veio.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT IGNORE INTO `audit_events` (
  `event_id`, `correlation_id`, `occurred_at`, `session_id`,
  `staff_account_id`, `staff_character_id`, `target_account_id`, `target_character_id`,
  `category`, `action`, `severity`, `outcome`, `source`,
  `permission`, `reason`, `before_state`, `after_state`, `metadata`,
  `legacy_audit_log_id`
)
SELECT
  CONCAT('legacy-', al.`id`)                                  AS event_id,
  NULL                                                        AS correlation_id,
  al.`created_at`                                             AS occurred_at,
  NULL                                                        AS session_id,
  al.`actor_account_id`                                       AS staff_account_id,
  NULL                                                        AS staff_character_id,
  al.`target_account_id`                                      AS target_account_id,
  NULL                                                        AS target_character_id,

  CASE
    WHEN al.`action` LIKE 'admin:%'      THEN SUBSTRING_INDEX(SUBSTRING(al.`action`, 7), '.', 1)
    WHEN al.`action` LIKE 'authz:%'      THEN 'security'
    WHEN al.`action` LIKE 'whitelist:%'  THEN 'whitelist'
    WHEN al.`action` LIKE 'governance:%' THEN 'governance'
    WHEN al.`action` = 'identity:staff_reveal' THEN 'identity'
    WHEN al.`action` IN ('staff:kick', 'staff:teleport', 'staff:playAnimation') THEN 'players'
    WHEN al.`action` = 'staff:addItem'         THEN 'inventory'
    WHEN al.`action` = 'staff:setGold'         THEN 'economy'
    WHEN al.`action` = 'staff:retireCharacter' THEN 'characters'
    WHEN al.`action` LIKE 'staff:voice%'       THEN 'voice'
    ELSE 'staff'
  END                                                         AS category,

  CASE
    WHEN al.`action` LIKE 'admin:%'      THEN SUBSTRING(al.`action`, 7)
    WHEN al.`action` LIKE 'authz:%'      THEN REPLACE(al.`action`, ':', '.')
    WHEN al.`action` LIKE 'whitelist:%'  THEN 'whitelist.review'
    WHEN al.`action` LIKE 'governance:%' THEN REPLACE(al.`action`, ':', '.')
    WHEN al.`action` = 'identity:staff_reveal' THEN 'identity.reveal'
    ELSE CONCAT('legacy.', SUBSTRING(al.`action`, 7))
  END                                                         AS action,

  -- Severidade das linhas antigas: `critical` so para o que nao se desfaz,
  -- `warning` para negacao. O resto entra como `info` — elevar por adivinhacao
  -- encheria o filtro de severidade de ruido justamente no historico, que e
  -- onde ele mais precisa ser confiavel.
  CASE
    WHEN al.`action` IN ('identity:staff_reveal', 'staff:retireCharacter') THEN 'critical'
    WHEN al.`action` = 'authz:denied' THEN 'warning'
    WHEN al.`action` IN ('staff:setGold', 'staff:addItem', 'staff:kick') THEN 'notice'
    WHEN al.`action` LIKE 'whitelist:%' THEN 'notice'
    ELSE 'info'
  END                                                         AS severity,

  CASE WHEN al.`action` = 'authz:denied' THEN 'denied' ELSE 'executed' END AS outcome,

  -- A origem nao era registrada antes da rodada do pipeline. `legacy` diz a
  -- verdade; inventar `command` ou `web` seria afirmar o que ninguem sabe.
  'legacy'                                                    AS source,

  NULL                                                        AS permission,
  NULL                                                        AS reason,
  NULL                                                        AS before_state,
  NULL                                                        AS after_state,
  JSON_OBJECT(
    'legacy_action',  al.`action`,
    'legacy_details', al.`details`
  )                                                           AS metadata,
  al.`id`                                                     AS legacy_audit_log_id

FROM `audit_logs` al
WHERE al.`action` LIKE 'admin:%'
   OR al.`action` LIKE 'authz:%'
   OR al.`action` LIKE 'staff:%'
   OR al.`action` LIKE 'whitelist:%'
   OR al.`action` LIKE 'governance:%'
   OR al.`action` = 'identity:staff_reveal';

-- ─────────────────────────────────────────────────────────────────────────────
-- Conferencia (rode a mao depois de aplicar)
--
--   -- quantas linhas de auditoria existiam, e quantas foram copiadas
--   SELECT
--     (SELECT COUNT(*) FROM audit_logs
--       WHERE action LIKE 'admin:%' OR action LIKE 'authz:%' OR action LIKE 'staff:%'
--          OR action LIKE 'whitelist:%' OR action LIKE 'governance:%'
--          OR action = 'identity:staff_reveal')      AS origem,
--     (SELECT COUNT(*) FROM audit_events
--       WHERE legacy_audit_log_id IS NOT NULL)       AS copiadas;
--
--   -- o que FICOU em audit_logs, por tipo (deve ser so evento de jogo)
--   SELECT SUBSTRING_INDEX(action, ':', 1) AS prefixo, COUNT(*) AS linhas
--     FROM audit_logs
--    WHERE legacy_audit_log_id IS NULL OR 1=1
--    GROUP BY prefixo ORDER BY linhas DESC;
-- ─────────────────────────────────────────────────────────────────────────────
