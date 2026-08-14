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
 * ## O que este módulo NÃO faz, e está registrado
 *
 * **Não persiste.** O silêncio vive na memória do processo e some no restart.
 * Persistir exigiria tabela, migration e uma decisão sobre expiração
 * (`muted_until`) que ninguém tomou ainda — e uma tabela criada "para depois"
 * é a forma mais cara de adiar. Enquanto isso, `describe()` existe justamente
 * para a staff conseguir listar quem está silenciado antes de reiniciar.
 *
 * Consequência honesta: **reiniciar o servidor devolve a voz de todo mundo.**
 * Está no §11 do documento da etapa como item aberto, não como detalhe.
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
 * @param {object} [deps]
 * @param {() => number} [deps.now]
 */
function createVoiceStaffMute(deps = {}) {
  const { now = () => Date.now() } = deps;

  /** @type {Map<number, StaffMuteEntry>} */
  const muted = new Map();

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
    return { ok: true, changed, entry };
  }

  /** @param {number} characterId */
  function unmute(characterId) {
    const changed = muted.delete(characterId);
    if (changed) _notify(characterId, false);
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

  return { mute, unmute, isMuted, get, describe, clear, size, onChange };
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

module.exports = { createVoiceStaffMute, sharedVoiceStaffMute };
