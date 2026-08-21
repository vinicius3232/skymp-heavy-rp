/**
 * core/voice/voice-staff-mute.js
 *
 * Silêncio aplicado pela staff. **Por personagem**, e só isso.
 *
 * ## Por que não é um estado de personagem
 *
 * `core/character-state.js` descreve o que aconteceu com o CORPO: abatido,
 * morto, algemado, preso. Silêncio de staff não é nada disso — é uma decisão
 * administrativa sobre um canal. Empurrá-lo para lá faria um jogador
 * silenciado deixar de poder minerar, porque `action-policy` bloqueia por
 * estado e o estado seria um só.
 *
 * A separação também é o que permite silenciar um morto, um preso e um
 * algemado sem escrever combinação nenhuma: as condições compõem
 * (`voice-conditions.js`), não competem.
 *
 * ## Persistência (SV-07, fechado na Etapa 4)
 *
 * O silêncio sobrevive ao restart. Antes não sobrevivia, e o efeito era pior do
 * que "a punição some": desde que ela passou a mexer no token do LiveKit
 * (SV-02), um restart devolvia a voz **e** reemitia tokens com
 * `canPublish: true`. A forma mais barata de escapar de uma punição era esperar
 * o próximo restart.
 *
 * **O banco entra injetado (`store`), e nunca no caminho crítico.** A ordem é
 * sempre: aplicar em memória → notificar → gravar. Um banco fora do ar atrasa a
 * durabilidade da punição; não impede a punição. O contrário — `await` numa
 * escrita antes de calar alguém — faria um MySQL lento virar uma janela em que
 * a staff manda calar e nada acontece.
 *
 * Sem `store`, o módulo se comporta exatamente como antes. É o que mantém os
 * testes puros e o que permite ao Voice Core rodar sem banco.
 *
 * A decisão sobre expiração que estava em aberto: `until` é conferido **na
 * leitura**, aqui e no SQL. Ver `migration-v16-voice-staff-mute.sql`.
 */

/**
 * @typedef {object} StaffMuteEntry
 * @property {number} characterId
 * @property {number|null} byCharacterId  quem aplicou
 * @property {string} reason
 * @property {number} at
 * @property {number|null} until  epoch ms; `null` = até alguém desfazer
 */

/**
 * @typedef {object} StaffMuteStore
 * @property {(entry: StaffMuteEntry) => Promise<void>} save
 * @property {(characterId: number) => Promise<void>} remove
 * @property {(nowMs: number) => Promise<StaffMuteEntry[]>} loadActive
 */

/**
 * @param {object} [deps]
 * @param {() => number} [deps.now]
 * @param {StaffMuteStore|null} [deps.store] persistência; sem ela o módulo é só memória
 * @param {Pick<Console,'warn'>} [deps.logger]
 */
function createVoiceStaffMute(deps = {}) {
  const { now = () => Date.now(), logger = console } = deps;

  /**
   * `let` e não `const` porque a instância compartilhada nasce sem banco.
   *
   * Se ela nascesse com o store de MySQL, todo teste que a tocasse tentaria
   * escrever — e a suíte roda sem banco. Quem liga a persistência é o boot do
   * servidor (`phase0-basic.js`), num ponto onde o banco já existe. Testes
   * passam o store pela construção e nunca precisam do setter.
   *
   * @type {StaffMuteStore|null}
   */
  let store = deps.store || null;

  /** @type {Map<number, StaffMuteEntry>} */
  const muted = new Map();

  /**
   * Escrita que não pode derrubar nada.
   *
   * A punição já está em memória quando isto roda. Se o banco estiver fora, o
   * que se perde é a durabilidade — e perder durabilidade é muito mais barato
   * que uma exceção subindo de dentro de um comando de staff, ou um
   * `unhandledRejection` derrubando o servidor de jogo por causa do MySQL.
   *
   * @param {Promise<unknown>} promessa
   * @param {string} oque
   */
  function _gravar(promessa, oque) {
    if (!promessa || typeof promessa.catch !== 'function') return;
    promessa.catch((err) => {
      logger.warn(
        `[voice-staff-mute] ${oque} não persistiu (${err && err.message}). ` +
        'A punição vale nesta execução e some no restart.'
      );
    });
  }

  /**
   * Carrega do banco o que ainda está valendo.
   *
   * Chamado no boot, antes de qualquer jogador entrar. Punição expirada nem sai
   * do SQL — a expiração é conferida na leitura, dos dois lados, e uma linha
   * vencida no banco não precisa virar entrada em memória para ser ignorada.
   */
  async function hydrate() {
    if (!store) return { ok: false, loaded: 0, reason: 'sem persistência configurada' };
    try {
      const linhas = await store.loadActive(now());
      let loaded = 0;
      for (const entry of linhas || []) {
        if (!entry || !Number.isFinite(entry.characterId)) continue;
        if (entry.until !== null && now() >= entry.until) continue;
        muted.set(entry.characterId, entry);
        loaded++;
      }
      return { ok: true, loaded };
    } catch (err) {
      // Boot não pode falhar por causa disto. Um servidor que não sobe porque o
      // registro de silêncio não carregou é uma indisponibilidade total causada
      // por uma funcionalidade acessória.
      logger.warn(`[voice-staff-mute] hydrate falhou (${err && err.message}); começando vazio.`);
      return { ok: false, loaded: 0, reason: err && err.message };
    }
  }

  /**
   * Quem quer saber que uma punição mudou.
   *
   * Existe para resolver um problema de DIREÇÃO de dependência. Quando a staff
   * cala alguém que já está conectado, o token daquela sessão precisa ser
   * reemitido sem `canPublish` — senão a punição só vale a partir da próxima
   * conexão, e a única defesa até lá é a camada de assinatura, que é justamente
   * a que o circuito aberto do gateway desliga.
   *
   * A forma óbvia seria o `admin-service` chamar o Voice Core depois de calar.
   * Isso poria o sistema de staff dependendo do sistema de voz — a direção
   * errada, e a mesma que este módulo existe para evitar (ver a instância
   * compartilhada no fim do arquivo). Com observador, quem se interessa é quem
   * se inscreve: o Voice Core assina, o `admin-service` continua sem saber que
   * ele existe.
   *
   * @type {Array<(characterId: number, muted: boolean) => void>}
   */
  const observers = [];

  /**
   * @param {(characterId: number, muted: boolean) => void} fn
   * @returns {() => void} cancela a inscrição
   */
  function onChange(fn) {
    observers.push(fn);
    return () => {
      const i = observers.indexOf(fn);
      if (i >= 0) observers.splice(i, 1);
    };
  }

  function _notify(characterId, isMutedNow) {
    for (const fn of observers) {
      try {
        fn(characterId, isMutedNow);
      } catch {
        // Um observador que lança não pode impedir a punição de ser aplicada.
        // O registro já está no Map antes desta linha; o que falha aqui é o
        // efeito colateral (reemitir token), e a rota continua cortando.
      }
    }
  }

  /**
   * Silencia um personagem.
   *
   * @param {number} characterId
   * @param {{byCharacterId?: number|null, reason?: string, durationMs?: number|null}} [opts]
   */
  function mute(characterId, opts = {}) {
    if (!Number.isFinite(characterId)) {
      return { ok: false, reason: 'characterId inválido' };
    }
    const duration = Number.isFinite(opts.durationMs) && opts.durationMs > 0 ? opts.durationMs : null;
    const entry = {
      characterId,
      byCharacterId: Number.isFinite(opts.byCharacterId) ? opts.byCharacterId : null,
      reason: typeof opts.reason === 'string' && opts.reason.trim() ? opts.reason.trim() : 'sem motivo registrado',
      at: now(),
      until: duration === null ? null : now() + duration
    };
    const changed = !muted.has(characterId);
    muted.set(characterId, entry);
    // Notifica mesmo quando `changed` é falso: recalar alguém já calado com
    // duração nova é uma mudança de punição, e o token precisa refletir a que
    // vale agora.
    _notify(characterId, true);
    // Por último, e sem `await`: a punição já vale. Ver `_gravar`.
    if (store) _gravar(store.save(entry), `mute de ${characterId}`);
    return { ok: true, changed, entry };
  }

  /** @param {number} characterId */
  function unmute(characterId) {
    const changed = muted.delete(characterId);
    if (changed) _notify(characterId, false);
    // Fora do `if (changed)` de propósito: se a memória não tinha a entrada mas
    // o banco tinha — hydrate que falhou, processo reiniciado no meio —, o
    // `unmute` da staff precisa alcançar o banco mesmo assim. Um `unmute` que
    // não faz nada porque a memória já estava limpa deixaria a punição
    // ressuscitar no próximo restart.
    if (store) _gravar(store.remove(characterId), `unmute de ${characterId}`);
    return { ok: true, changed };
  }

  /**
   * Este personagem está silenciado AGORA?
   *
   * A expiração é conferida na leitura, não por timer. Um `setTimeout` por
   * silêncio significaria um timer vivo por punição, sobrevivendo a logout e a
   * `unmute`, e um deles disparando depois de o personagem já ter sido
   * silenciado de novo — desfazendo a segunda punição por causa da primeira.
   *
   * @param {number} characterId
   */
  function isMuted(characterId) {
    const entry = muted.get(characterId);
    if (!entry) return false;
    if (entry.until !== null && now() >= entry.until) {
      muted.delete(characterId);
      // A linha vencida sai do banco também. Sem isto ela ficaria para sempre,
      // e o `loadActive` de todo boot pagaria por punições de meses atrás.
      if (store) _gravar(store.remove(characterId), `expiração de ${characterId}`);
      return false;
    }
    return true;
  }

  /** @param {number} characterId @returns {StaffMuteEntry|null} */
  function get(characterId) {
    return isMuted(characterId) ? muted.get(characterId) || null : null;
  }

  /** Lista para a staff. Expirados saem no caminho. */
  function describe() {
    const list = [];
    for (const characterId of [...muted.keys()]) {
      if (isMuted(characterId)) list.push({ ...muted.get(characterId) });
    }
    return list;
  }

  function clear() {
    muted.clear();
  }

  function size() {
    return describe().length;
  }

  /**
   * Liga a persistência depois da construção. Só o boot usa isto.
   * @param {StaffMuteStore|null} novo
   */
  function setStore(novo) {
    store = novo || null;
  }

  return { mute, unmute, isMuted, get, describe, clear, size, onChange, hydrate, setStore };
}

/**
 * Persistência real, em MySQL.
 *
 * Fica neste arquivo e não num módulo separado porque é pequena e porque
 * separá-la criaria um arquivo cujo único propósito seria três SQLs. O que
 * importa é que ela entra por injeção: quem constrói o registro decide se há
 * banco, e nenhum teste do Voice Core precisa de um.
 *
 * `require` preguiçoso: `../database` abre pool de conexão ao ser carregado, e
 * um teste que só quer a lógica de silêncio não pode arrastar MySQL junto.
 *
 * @returns {StaffMuteStore}
 */
function createMysqlStaffMuteStore() {
  const db = require('../../database');

  return {
    async save(entry) {
      // `ON DUPLICATE KEY UPDATE` porque recalar alguém já calado é o caso
      // normal, não o excepcional: a staff aumenta uma punição com mais
      // frequência do que cria a primeira.
      await db.query(
        'INSERT INTO `voice_staff_mutes` (`character_id`, `by_character_id`, `reason`, `muted_at`, `muted_until`) ' +
        'VALUES (?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE `by_character_id` = VALUES(`by_character_id`), ' +
        '`reason` = VALUES(`reason`), `muted_at` = VALUES(`muted_at`), `muted_until` = VALUES(`muted_until`)',
        [entry.characterId, entry.byCharacterId, entry.reason, entry.at, entry.until]
      );
    },

    async remove(characterId) {
      await db.query('DELETE FROM `voice_staff_mutes` WHERE `character_id` = ?', [characterId]);
    },

    async loadActive(nowMs) {
      // O filtro de expiração está no SQL **e** no `hydrate`. Redundante de
      // propósito: o SQL evita trazer linhas mortas pela rede, e a checagem em
      // JS é a que vale se algum dia esta query mudar.
      const linhas = await db.query(
        'SELECT `character_id`, `by_character_id`, `reason`, `muted_at`, `muted_until` ' +
        'FROM `voice_staff_mutes` WHERE `muted_until` IS NULL OR `muted_until` > ?',
        [nowMs]
      );
      return (linhas || []).map((r) => ({
        characterId: Number(r.character_id),
        byCharacterId: r.by_character_id === null ? null : Number(r.by_character_id),
        reason: String(r.reason),
        at: Number(r.muted_at),
        until: r.muted_until === null ? null : Number(r.muted_until)
      }));
    }
  };
}

/**
 * Instância compartilhada do processo.
 *
 * Existe porque `admin-service` e o Voice Core precisam olhar o MESMO registro,
 * e passar a instância entre eles exigiria que o `admin-service` conhecesse o
 * Voice Core — uma dependência do sistema de staff no sistema de voz, na
 * direção errada. As fábricas continuam exportadas para os testes, que nunca
 * devem compartilhar registro entre si.
 */
const sharedVoiceStaffMute = createVoiceStaffMute();

module.exports = { createVoiceStaffMute, createMysqlStaffMuteStore, sharedVoiceStaffMute };
