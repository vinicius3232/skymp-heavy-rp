-- v19 — world_time_state: o relogio autoritativo do servidor
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Por que uma tabela de UMA linha, e nao um KV genérico
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `environment-service.js` (Time Sync) precisa sobreviver a um restart sem o
-- mundo "voltar no tempo": o relogio em memoria do processo e a UNICA
-- autoridade enquanto o servidor esta de pe (nunca le o banco de novo para
-- decidir o proximo valor), e o banco existe so para o boot seguinte saber
-- onde retomar. Isso pede exatamente uma linha, nao um historico — gravar
-- cada tick criaria uma tabela que cresce para sempre sem nenhum consumidor
-- do historico (mesmo raciocinio de "avaliar necessidade real antes de criar
-- tabela" que a migration v18 aplicou ao catalogo de profissoes).
--
-- `CHECK (id = 1)` fecha a porta para uma segunda linha aparecer por engano —
-- um INSERT com id diferente falha alto, em vez de o servidor silenciosamente
-- passar a ler/escrever a linha errada.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- O que esta migration NAO cria
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Nenhuma coluna de clima. `docs/technical/ENVIRONMENT_WEATHER_SPIKE.md`
-- documenta por que: nao existe binding de Weather/ForceWeather confirmado na
-- API do SkyMP (`skymp/gamemode/types/mp.d.ts`), e o proprio
-- `docs/MODDING_GUIDELINES.md` ja registra a duvida de transicao suave como
-- em aberto. Persistir estado de clima antes de confirmar que o servidor
-- consegue FORCAR clima de verdade seria peristir um campo que nada le.
--
-- ═══════════════════════════════════════════════════════════════════════════

USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `world_time_state` (
  -- Linha unica travada em 1 pelo CHECK abaixo — ver a nota de decisao acima.
  `id`                INT NOT NULL DEFAULT 1,

  -- Dias de jogo decorridos desde a epoca do servidor (double, nao int: o
  -- relogio avanca em fracoes de dia a cada tick, e truncar aqui teria o
  -- mesmo efeito pratico de perder tempo a cada persistencia).
  `game_days_passed`  DOUBLE NOT NULL DEFAULT 0,

  -- Velocidade do tempo de jogo relativa ao tempo real. 20 e o padrao vanilla
  -- do Skyrim (1 hora real ~= 20 horas de jogo); configuravel via
  -- INITIAL_TIMESCALE no boot, mas so nesta linha depois do primeiro boot —
  -- reiniciar o servidor NAO reseta para o valor do .env, ele retoma daqui.
  `timescale`         FLOAT NOT NULL DEFAULT 20,

  `updated_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  CONSTRAINT `chk_world_time_single_row` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
