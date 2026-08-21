/**
 * core/voice/voice-policy-conditions.test.js
 *
 * A equação da Etapa 3, ponta a ponta:
 *
 * ```
 *   Locutor + Ouvinte + Estado do personagem + Estado do mundo = VoiceRoute
 * ```
 *
 * ## O que estes testes protegem
 *
 * **Que exista uma porta só.** `canSpeak`, `canHear`, `audienceProbe` e
 * `resolveRoute` são quatro superfícies da mesma regra, e a forma de garantir
 * que ninguém acrescente um `if (dead)` numa delas é exigir que as quatro
 * concordem — inclusive nos modificadores, não só no sim/não.
 *
 * **Nenhum modificador é escrito à mão aqui.** Todos vêm de
 * `conditionProfiles()`, que os lê do `server-options`. Ver o cabeçalho de
 * `voice-conditions.test.js`.
 */

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

const { VOICE_RANGES } = require('../proximity-ranges');
const { createVoiceStateService, CONNECTION_STATES, DEFAULT_VOICE_MODE } = require('./voice-state');
const { createVoicePolicyEngine } = require('./voice-policy');
const { createVoiceOcclusion } = require('./voice-occlusion');
const { VOICE_CONDITIONS, VOICE_EFFECTS, conditionProfiles } = require('./voice-conditions');

const A = 0xff00d001;
const B = 0xff00d002;
const CELL = '162e2:Skyrim.esm';
const OUTRA_CELL = '1a2b3:Skyrim.esm';

/**
 * Adapter de condições controlado pelo teste.
 *
 * Aponta para `actorId` porque, neste arquivo, `characterId === actorId` — o
 * `pronto()` abaixo os iguala de propósito, para que a leitura fique sobre a
 * regra e não sobre a tradução (que tem arquivo de teste próprio).
 */
function adapterFalso() {
  const porPersonagem = new Map();
  return {
    definir(characterId, ...conditions) { porPersonagem.set(characterId, conditions); },
    limpar(characterId) { porPersonagem.delete(characterId); },
    conditionsOf: (characterId) => porPersonagem.get(characterId) || []
  };
}

function amostra(actorId, pos, space = CELL) {
  return { actorId, space, pos };
}

let state;
let conditions;
let policy;
let perfis;

beforeEach(() => {
  state = createVoiceStateService();
  conditions = adapterFalso();
  policy = createVoicePolicyEngine({
    state, conditions, occlusion: createVoiceOcclusion()
  });
  perfis = conditionProfiles();
});

/** Ator pronto para falar: personagem carregado, conectado, PTT apertado. */
function pronto(actorId, mode = DEFAULT_VOICE_MODE) {
  state.ensure(actorId, { characterId: actorId });
  state.setConnectionState(actorId, CONNECTION_STATES.CONNECTED);
  state.setVoiceMode(actorId, mode);
  policy.pttDown(actorId);
}

/** Só ouvindo. */
function ouvindo(actorId) {
  state.ensure(actorId, { characterId: actorId });
  state.setConnectionState(actorId, CONNECTION_STATES.CONNECTED);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('condições — quem NÃO fala', () => {
  it('MORTO não fala, e o motivo diz que é a morte', () => {
    pronto(A);
    conditions.definir(A, VOICE_CONDITIONS.DEAD);

    const verdict = policy.canSpeak(A);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, perfis[VOICE_CONDITIONS.DEAD].reason);
  });

  it('INCONSCIENTE não fala', () => {
    pronto(A);
    conditions.definir(A, VOICE_CONDITIONS.UNCONSCIOUS);
    assert.strictEqual(policy.canSpeak(A).ok, false);
  });

  it('SILENCIADO PELA STAFF não fala', () => {
    pronto(A);
    conditions.definir(A, VOICE_CONDITIONS.STAFF_MUTED);

    const verdict = policy.canSpeak(A);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, perfis[VOICE_CONDITIONS.STAFF_MUTED].reason);
  });

  /**
   * A prova de que não basta `canSpeak` devolver `false`: o que decide se a voz
   * sai é a rota. Um sistema que recusasse na permissão e continuasse gerando
   * audiência entregaria áudio de um cadáver.
   */
  it('morto não gera AUDIÊNCIA — não só permissão negada', () => {
    pronto(A);
    ouvindo(B);
    conditions.definir(A, VOICE_CONDITIONS.DEAD);

    assert.strictEqual(policy.audienceProbe(amostra(A, [0, 0, 0])), null);
    assert.strictEqual(policy.canHear(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0])).ok, false);
  });

  it('silenciado pela staff CONTINUA OUVINDO os outros', () => {
    pronto(B);
    ouvindo(A);
    conditions.definir(A, VOICE_CONDITIONS.STAFF_MUTED);

    assert.strictEqual(policy.canListen(A).ok, true);
    assert.strictEqual(policy.canHear(amostra(A, [10, 0, 0]), amostra(B, [0, 0, 0])).ok, true,
      'senão a punição vira desconexão disfarçada');
  });
});

describe('condições — quem não OUVE', () => {
  it('inconsciente e morto ouvem conforme a configuração, e ela é respeitada', () => {
    pronto(B);
    ouvindo(A);

    for (const condicao of [VOICE_CONDITIONS.UNCONSCIOUS, VOICE_CONDITIONS.DEAD]) {
      conditions.definir(A, condicao);
      const esperado = perfis[condicao].canHear;
      assert.strictEqual(policy.canListen(A).ok, esperado, condicao);
      assert.strictEqual(
        policy.canHear(amostra(A, [10, 0, 0]), amostra(B, [0, 0, 0])).ok, esperado,
        `${condicao}: a rota tem que concordar com a permissão`
      );
    }
  });

  it('quem não ouve some da audiência do outro, mesmo encostado', () => {
    pronto(B);
    ouvindo(A);
    conditions.definir(A, VOICE_CONDITIONS.UNCONSCIOUS);

    const probe = policy.audienceProbe(amostra(B, [0, 0, 0]));
    assert.ok(probe, 'B pode falar');
    assert.strictEqual(probe(amostra(A, [1, 0, 0])), 0,
      'senão o cliente de um inconsciente toca a cena inteira');
  });
});

describe('condições — AMORDAÇADO é efeito, não mute', () => {
  it('amordaçado CONTINUA sendo ouvido de perto', () => {
    pronto(A);
    ouvindo(B);
    conditions.definir(A, VOICE_CONDITIONS.GAGGED);

    const verdict = policy.canHear(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0]));
    assert.strictEqual(verdict.ok, true, 'calar por completo seria a solução preguiçosa');
    assert.ok(verdict.volume > 0);
  });

  it('e vem com o efeito ABAFADO, para o cliente filtrar', () => {
    pronto(A);
    ouvindo(B);
    conditions.definir(A, VOICE_CONDITIONS.GAGGED);

    assert.strictEqual(
      policy.canHear(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0])).effect,
      perfis[VOICE_CONDITIONS.GAGGED].effect
    );
  });

  it('o ALCANCE encolhe pelo modificador da mordaça', () => {
    pronto(A);
    ouvindo(B);

    const semMordaca = policy.audienceProbe(amostra(A, [0, 0, 0])).range;
    conditions.definir(A, VOICE_CONDITIONS.GAGGED);
    const comMordaca = policy.audienceProbe(amostra(A, [0, 0, 0])).range;

    assert.strictEqual(comMordaca, semMordaca * perfis[VOICE_CONDITIONS.GAGGED].rangeModifier);
    assert.ok(comMordaca < semMordaca);
  });

  /**
   * A mordaça abafa o que a pessoa escolheu dizer — ela não redefine o modo.
   * Um sussurro amordaçado alcança uma fração do SUSSURRO, não uma fração do
   * grito nem um alcance fixo.
   */
  it('o modificador se aplica sobre o MODO, não sobre um alcance fixo', () => {
    pronto(A, 'shout');
    conditions.definir(A, VOICE_CONDITIONS.GAGGED);
    const gritoAmordacado = policy.audienceProbe(amostra(A, [0, 0, 0])).range;

    state.setVoiceMode(A, 'whisper');
    const sussurroAmordacado = policy.audienceProbe(amostra(A, [0, 0, 0])).range;

    assert.strictEqual(gritoAmordacado, VOICE_RANGES.shout * perfis[VOICE_CONDITIONS.GAGGED].rangeModifier);
    assert.strictEqual(sussurroAmordacado, VOICE_RANGES.whisper * perfis[VOICE_CONDITIONS.GAGGED].rangeModifier);
  });

  it('o GANHO cai pelo modificador, na mesma distância', () => {
    pronto(A);
    ouvindo(B);
    const perto = amostra(B, [10, 0, 0]);

    const semMordaca = policy.canHear(perto, amostra(A, [0, 0, 0])).volume;
    conditions.definir(A, VOICE_CONDITIONS.GAGGED);
    const comMordaca = policy.canHear(perto, amostra(A, [0, 0, 0])).volume;

    assert.ok(comMordaca < semMordaca);
    assert.ok(comMordaca > 0, 'ganho zero seria mute com outro nome');
  });

  it('quem estava longe e ainda dentro do alcance normal SOME quando amordaçado', () => {
    pronto(A);
    ouvindo(B);
    // Metade do alcance normal: dentro sem mordaça, fora com ela (o modificador
    // é menor que 0.5 por padrão — e o teste deriva isso em vez de assumir).
    const meio = VOICE_RANGES[DEFAULT_VOICE_MODE] * 0.5;
    const longe = amostra(B, [meio, 0, 0]);

    assert.strictEqual(policy.canHear(longe, amostra(A, [0, 0, 0])).ok, true);

    conditions.definir(A, VOICE_CONDITIONS.GAGGED);
    const esperado = perfis[VOICE_CONDITIONS.GAGGED].rangeModifier > 0.5;
    assert.strictEqual(policy.canHear(longe, amostra(A, [0, 0, 0])).ok, esperado);
  });
});

describe('condições — ABATIDO é configurável', () => {
  it('fala ou não conforme `voice.downed.canSpeak`', () => {
    pronto(A);
    conditions.definir(A, VOICE_CONDITIONS.DOWNED);
    assert.strictEqual(policy.canSpeak(A).ok, perfis[VOICE_CONDITIONS.DOWNED].canSpeak);
  });

  it('quando fala, é com os modificadores da configuração', () => {
    if (!perfis[VOICE_CONDITIONS.DOWNED].canSpeak) return;
    pronto(A);
    ouvindo(B);

    const cheio = policy.audienceProbe(amostra(A, [0, 0, 0])).range;
    conditions.definir(A, VOICE_CONDITIONS.DOWNED);
    const probe = policy.audienceProbe(amostra(A, [0, 0, 0]));

    assert.strictEqual(probe.range, cheio * perfis[VOICE_CONDITIONS.DOWNED].rangeModifier);
    assert.strictEqual(probe.gainModifier, perfis[VOICE_CONDITIONS.DOWNED].gainModifier);
    assert.strictEqual(probe.effect, perfis[VOICE_CONDITIONS.DOWNED].effect);
  });
});

describe('condições — composição no caminho real', () => {
  it('ABATIDO + AMORDAÇADO soa mais baixo que abatido sozinho', () => {
    if (!perfis[VOICE_CONDITIONS.DOWNED].canSpeak) return;
    pronto(A);
    ouvindo(B);
    const ouvinte = amostra(B, [10, 0, 0]);

    conditions.definir(A, VOICE_CONDITIONS.DOWNED);
    const soAbatido = policy.canHear(ouvinte, amostra(A, [0, 0, 0])).volume;

    conditions.definir(A, VOICE_CONDITIONS.DOWNED, VOICE_CONDITIONS.GAGGED);
    const abatidoAmordacado = policy.canHear(ouvinte, amostra(A, [0, 0, 0]));

    assert.ok(abatidoAmordacado.volume < soAbatido,
      'escolher "a condição mais grave" apagaria a mordaça aqui');
    assert.strictEqual(abatidoAmordacado.effect, VOICE_EFFECTS.MUFFLED);
  });
});

describe('condições — TRANSIÇÃO de estado', () => {
  /**
   * Morrer no meio da frase. Nenhum recompute aconteceu entre uma linha e a
   * outra: o que muda a resposta é a condição, lida na hora.
   */
  it('morrer corta a voz na leitura seguinte, sem esperar tick', () => {
    pronto(A);
    ouvindo(B);
    const ouvinte = amostra(B, [10, 0, 0]);

    assert.strictEqual(policy.canHear(ouvinte, amostra(A, [0, 0, 0])).ok, true);
    conditions.definir(A, VOICE_CONDITIONS.DEAD);
    assert.strictEqual(policy.canHear(ouvinte, amostra(A, [0, 0, 0])).ok, false);
  });

  it('ser socorrido devolve a voz — a transição vale nos dois sentidos', () => {
    pronto(A);
    ouvindo(B);
    const ouvinte = amostra(B, [10, 0, 0]);

    conditions.definir(A, VOICE_CONDITIONS.DOWNED);
    conditions.limpar(A);

    const verdict = policy.canHear(ouvinte, amostra(A, [0, 0, 0]));
    assert.strictEqual(verdict.ok, true);
    assert.strictEqual(verdict.effect, VOICE_EFFECTS.NONE, 'o efeito também tem que sair');
  });

  /**
   * O cache de perfil vive DENTRO de um ciclo de recompute e não pode
   * sobreviver a ele — um perfil de 150 ms atrás faria um cadáver terminar a
   * frase no ciclo seguinte.
   */
  it('o cache de ciclo não sobrevive ao ciclo', () => {
    pronto(A);
    policy.beginCycle();
    assert.strictEqual(policy.canSpeak(A).ok, true);
    conditions.definir(A, VOICE_CONDITIONS.DEAD);
    assert.strictEqual(policy.canSpeak(A).ok, true, 'dentro do ciclo, a resposta é estável');
    policy.endCycle();
    assert.strictEqual(policy.canSpeak(A).ok, false, 'fora dele, a fonte manda');
  });

  it('dentro de um ciclo o adapter é consultado UMA vez por ator', () => {
    let leituras = 0;
    const contando = {
      conditionsOf: (id) => { leituras++; return []; }
    };
    const p = createVoicePolicyEngine({ state, conditions: contando });
    state.ensure(A, { characterId: A });
    state.setConnectionState(A, CONNECTION_STATES.CONNECTED);

    p.beginCycle();
    for (let i = 0; i < 50; i++) p.profileOf(A);
    p.endCycle();

    assert.strictEqual(leituras, 1, '50 pares não podem custar 50 leituras de estado');
  });
});

describe('condições — as quatro superfícies concordam', () => {
  /**
   * `canSpeak`, `canListen`, `canHear`, `audienceProbe` e `resolveRoute` são a
   * mesma regra vista de cinco ângulos. Um `if` acrescentado a uma delas
   * quebraria este caso — que é o único jeito de a instrução "não espalhe as
   * regras" continuar valendo depois que outra pessoa mexer no arquivo.
   */
  it('varredura: toda combinação de condição dá o mesmo veredito nas cinco', () => {
    const combinacoes = [
      [],
      [VOICE_CONDITIONS.DEAD],
      [VOICE_CONDITIONS.UNCONSCIOUS],
      [VOICE_CONDITIONS.DOWNED],
      [VOICE_CONDITIONS.GAGGED],
      [VOICE_CONDITIONS.STAFF_MUTED],
      [VOICE_CONDITIONS.DOWNED, VOICE_CONDITIONS.GAGGED],
      [VOICE_CONDITIONS.DEAD, VOICE_CONDITIONS.STAFF_MUTED]
    ];

    for (const doLocutor of combinacoes) {
      for (const doOuvinte of combinacoes) {
        state.clear();
        pronto(A);
        ouvindo(B);
        conditions.limpar(A);
        conditions.limpar(B);
        conditions.definir(A, ...doLocutor);
        conditions.definir(B, ...doOuvinte);

        const locutor = amostra(A, [0, 0, 0]);
        const ouvinte = amostra(B, [10, 0, 0]);

        const porCanHear = policy.canHear(ouvinte, locutor);
        const probe = policy.audienceProbe(locutor);
        const porProbe = probe ? probe(ouvinte) : 0;
        const rota = policy.resolveRoute(ouvinte, locutor);

        const rotulo = `locutor[${doLocutor}] ouvinte[${doOuvinte}]`;
        assert.strictEqual(porCanHear.volume, porProbe, `${rotulo}: volume`);
        assert.strictEqual(porCanHear.ok, porProbe > 0, `${rotulo}: veredito`);
        assert.strictEqual(rota.allowed, porCanHear.ok, `${rotulo}: resolveRoute.allowed`);
        assert.strictEqual(rota.gain, porCanHear.volume, `${rotulo}: resolveRoute.gain`);
        if (!porCanHear.ok) {
          assert.ok(rota.reason, `${rotulo}: recusa sem motivo é log inútil`);
        }
      }
    }
  });
});

describe('resolveRoute — os cinco campos que a etapa pediu', () => {
  it('rota permitida traz allowed, gain, rangeModifier, effect e reason', () => {
    pronto(A);
    ouvindo(B);
    conditions.definir(A, VOICE_CONDITIONS.GAGGED);

    const rota = policy.resolveRoute(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0]));

    assert.strictEqual(rota.allowed, true);
    assert.ok(rota.gain > 0 && rota.gain <= 1);
    assert.strictEqual(rota.rangeModifier, perfis[VOICE_CONDITIONS.GAGGED].rangeModifier);
    assert.strictEqual(rota.gainModifier, perfis[VOICE_CONDITIONS.GAGGED].gainModifier);
    assert.strictEqual(rota.effect, perfis[VOICE_CONDITIONS.GAGGED].effect);
    assert.strictEqual(rota.reason, null, 'rota permitida não tem motivo de recusa');
    assert.deepStrictEqual(rota.conditions.speaker, [VOICE_CONDITIONS.GAGGED]);
  });

  it('rota recusada traz o motivo e NENHUM efeito', () => {
    pronto(A);
    ouvindo(B);
    conditions.definir(A, VOICE_CONDITIONS.DEAD);

    const rota = policy.resolveRoute(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0]));
    assert.strictEqual(rota.allowed, false);
    assert.strictEqual(rota.gain, 0);
    assert.strictEqual(rota.effect, VOICE_EFFECTS.NONE,
      'aplicar filtro em áudio que não vai tocar seria CPU gasta em silêncio');
    assert.strictEqual(rota.reason, perfis[VOICE_CONDITIONS.DEAD].reason);
  });
});

describe('mundo — isolamento de célula continua acima de tudo', () => {
  it('células diferentes não produzem rota, com coordenadas IDÊNTICAS', () => {
    pronto(A);
    ouvindo(B);

    const verdict = policy.canHear(
      { actorId: B, space: OUTRA_CELL, pos: [0, 0, 0] },
      { actorId: A, space: CELL, pos: [0, 0, 0] }
    );
    assert.strictEqual(verdict.ok, false);
    assert.ok(/célula|worldspace/.test(verdict.reason));
  });

  it('a vedação vence até a mordaça — parede não vira efeito', () => {
    pronto(A);
    ouvindo(B);
    conditions.definir(A, VOICE_CONDITIONS.GAGGED);

    const verdict = policy.canHear(
      { actorId: B, space: OUTRA_CELL, pos: [0, 0, 0] },
      { actorId: A, space: CELL, pos: [0, 0, 0] }
    );
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.effect, VOICE_EFFECTS.NONE);
  });

  it('com provedor de portal, a parede vira porta e o efeito aparece', () => {
    const occlusion = createVoiceOcclusion();
    occlusion.setPortalProvider(() => ({
      blocked: false, rangeModifier: 1, gainModifier: 0.3, effect: VOICE_EFFECTS.MUFFLED, reason: 'porta'
    }));
    const p = createVoicePolicyEngine({ state, conditions, occlusion });

    state.ensure(A, { characterId: A });
    state.setConnectionState(A, CONNECTION_STATES.CONNECTED);
    p.pttDown(A);
    ouvindo(B);

    const verdict = p.canHear(
      { actorId: B, space: OUTRA_CELL, pos: [10, 0, 0] },
      { actorId: A, space: CELL, pos: [0, 0, 0] }
    );
    assert.strictEqual(verdict.ok, true, 'o nível 2 muda a resposta sem tocar na política');
    assert.strictEqual(verdict.effect, VOICE_EFFECTS.MUFFLED);
  });
});

describe('mundo — atenuação por distância continua contínua', () => {
  it('o volume cai monotonicamente até o corte, com e sem mordaça', () => {
    pronto(A);
    ouvindo(B);
    const alcance = VOICE_RANGES[DEFAULT_VOICE_MODE];

    for (const condicao of [[], [VOICE_CONDITIONS.GAGGED]]) {
      conditions.limpar(A);
      conditions.definir(A, ...condicao);

      let anterior = Infinity;
      for (let d = 0; d < alcance; d += alcance / 20) {
        const v = policy.canHear(amostra(B, [d, 0, 0]), amostra(A, [0, 0, 0])).volume;
        assert.ok(v <= anterior, `[${condicao}] volume subiu de ${anterior} para ${v} em d=${d}`);
        anterior = v;
      }
      assert.strictEqual(
        policy.canHear(amostra(B, [alcance * 2, 0, 0]), amostra(A, [0, 0, 0])).volume, 0,
        `[${condicao}] além do alcance é silêncio total`
      );
    }
  });
});
