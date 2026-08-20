/**
 * core/permissions.test.js
 *
 * O catálogo é a fonte única de verdade sobre autorização em quatro processos.
 * Um erro aqui não fica contido num deles — ele vira acesso indevido no painel,
 * comando negado em jogo, ou um cargo que existe no banco e não existe no
 * código, tudo em silêncio. Estes testes são o portão.
 *
 * ─── O que estes testes protegem que os outros não protegem ─────────────────
 *
 * `permissions.behavior.test.js` pergunta "o handler de fato chama a checagem?",
 * invocando o comando real e olhando o efeito colateral. Ele é insubstituível e
 * não cobre nada do que está aqui: ele parte de um catálogo correto.
 *
 * Este arquivo pergunta o que aquele assume. Quatro classes de defeito, todas
 * com precedente neste projeto:
 *
 *   1. **Permissão concedida sem porta.** `ban` esteve concedida a `admin` e
 *      `owner` desde sempre, sem comando, sem endpoint e sem tabela. A suíte
 *      inteira passava — ela cobria "todo handler está na matriz", nunca "toda
 *      permissão declarada tem handler". A varredura da §4 fecha isso.
 *   2. **Cargo que um lado conhece e o outro não.** `role='support'` dava acesso
 *      total ao painel e zero em jogo, sem que nada reclamasse.
 *   3. **Nome que nega sempre.** Nível numérico legado contra um `Set` de
 *      strings negava tudo, inclusive para `owner`, sem explodir.
 *   4. **Reservada tratada como ativa.** O defeito novo que este desenho
 *      introduz: declarar um nome sem poder é seguro só enquanto ninguém o
 *      concede a um cargo por engano.
 *
 * Executa com: node --test core/permissions.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');

const perms = require('./permissions');

const CARGOS = ['moderator', 'admin', 'owner'];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Forma e coerência do catálogo
// ─────────────────────────────────────────────────────────────────────────────

describe('catálogo — forma', () => {
  it('todo nome é uma capability bem formada', () => {
    for (const nome of Object.keys(perms.CAPABILITIES)) {
      assert.ok(
        perms.isWellFormed(nome),
        `'${nome}' não é 'dominio.acao' minúsculo. O catálogo é o único lugar onde a forma é definida; ` +
        `um nome torto aqui nega para todo mundo e o log culpa quem chamou.`
      );
    }
  });

  it('toda capability declara descrição, status e ponto de aplicação', () => {
    for (const [nome, cap] of Object.entries(perms.CAPABILITIES)) {
      assert.ok(cap.description && cap.description.length > 10, `'${nome}' sem descrição útil`);
      assert.ok(['active', 'reserved'].includes(cap.status), `'${nome}' com status inválido: ${cap.status}`);
      assert.ok(cap.enforcedAt && cap.enforcedAt.length > 5, `'${nome}' sem enforcedAt`);
    }
  });

  it('todo cargo concede apenas capabilities que existem', () => {
    for (const cargo of CARGOS) {
      for (const nome of perms.ROLE_CAPABILITIES[cargo]) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(perms.CAPABILITIES, nome),
          `cargo '${cargo}' concede '${nome}', que não está no catálogo. Isso nega sempre — ` +
          `é uma porta que nunca abre, e ninguém percebe porque negar parece funcionar.`
        );
      }
    }
  });

  it('nenhum cargo concede a mesma capability duas vezes', () => {
    for (const cargo of CARGOS) {
      const lista = perms.ROLE_CAPABILITIES[cargo];
      assert.equal(new Set(lista).size, lista.length, `cargo '${cargo}' tem capability repetida`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. `active` × `reserved` — a invariante que impede `ban` de acontecer de novo
// ─────────────────────────────────────────────────────────────────────────────

describe('catálogo — active e reserved', () => {
  it('toda capability ATIVA é concedida a pelo menos um cargo', () => {
    const orfas = perms.activePermissions().filter(
      (nome) => !CARGOS.some((cargo) => perms.ROLE_CAPABILITIES[cargo].includes(nome))
    );
    assert.deepEqual(
      orfas, [],
      `Capability(ies) ativa(s) que nenhum cargo tem: ${orfas.join(', ')}. ` +
      `Existe ponto de aplicação e ninguém pode passar por ele — a funcionalidade está morta e parece viva.`
    );
  });

  it('nenhuma capability RESERVADA é concedida a cargo nenhum', () => {
    const vazadas = [];
    for (const cargo of CARGOS) {
      for (const nome of perms.ROLE_CAPABILITIES[cargo]) {
        if (perms.CAPABILITIES[nome] && perms.CAPABILITIES[nome].status === 'reserved') {
          vazadas.push(`${cargo}:${nome}`);
        }
      }
    }
    assert.deepEqual(
      vazadas, [],
      `Capability(ies) RESERVADA(S) concedida(s): ${vazadas.join(', ')}. ` +
      `Reservada significa que o poder não existe. Conceder uma é recriar exatamente o defeito do 'ban': ` +
      `uma permissão que descreve um poder inexistente, e que quem auditar vai ler como poder real.`
    );
  });

  it('reservada nega para TODO cargo, owner incluído', () => {
    for (const nome of perms.reservedPermissions()) {
      for (const cargo of CARGOS) {
        const d = perms.decide(cargo, nome);
        assert.equal(d.allowed, false, `'${cargo}' passou em '${nome}', que é reservada`);
        assert.equal(
          d.reason, perms.DENIAL.RESERVED_PERMISSION,
          `'${nome}' negou por '${d.reason}' em vez de 'reserved_permission' — o motivo importa: ` +
          `lido como falta de cargo, alguém "conserta" promovendo a pessoa.`
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. As quatro negações
// ─────────────────────────────────────────────────────────────────────────────

describe('negações', () => {
  it('cargo desconhecido nega tudo', () => {
    for (const nome of perms.activePermissions()) {
      const d = perms.decide('support', nome);
      assert.equal(d.allowed, false, `cargo 'support' passou em '${nome}'`);
      assert.equal(d.reason, perms.DENIAL.UNKNOWN_ROLE);
    }
  });

  it('sem cargo nega tudo', () => {
    for (const valor of [null, undefined, '']) {
      const d = perms.decide(valor, 'players.kick');
      assert.equal(d.allowed, false);
      assert.equal(d.reason, perms.DENIAL.NO_ROLE);
    }
  });

  it('permissão desconhecida nega, mesmo para owner', () => {
    for (const nome of ['manage_factions', 'players.explode', 'economy.print_money']) {
      const d = perms.decide('owner', nome);
      assert.equal(d.allowed, false, `owner passou em '${nome}'`);
      assert.equal(d.reason, perms.DENIAL.UNKNOWN_PERMISSION);
    }
  });

  it('permissão malformada nega, mesmo para owner', () => {
    for (const valor of [20, 10, null, undefined, {}, [], 'Players.Kick', 'players kick', 'players.', '.kick', 'players.kick.extra']) {
      const d = perms.decide('owner', valor);
      assert.equal(d.allowed, false, `owner passou em ${JSON.stringify(valor)}`);
      assert.equal(
        d.reason, perms.DENIAL.MALFORMED_PERMISSION,
        `${JSON.stringify(valor)} negou por '${d.reason}'`
      );
    }
  });

  it('nome legado inexistente é DESCONHECIDO, não malformado', () => {
    // A distinção manda quem lê o log para lados opostos: "malformada" faz a
    // pessoa consertar a forma (`manage.factions`) e continuar sem existir.
    const d = perms.decide('owner', 'manage_factions');
    assert.equal(d.reason, perms.DENIAL.UNKNOWN_PERMISSION);
    assert.match(perms.explain(d), /desconhecida/);
  });

  it('nível numérico legado tem redação própria no log', () => {
    const d = perms.decide('owner', 20);
    assert.match(
      perms.explain(d), /em vez de um nome de permissão/,
      'o caso do nível numérico já custou caro uma vez; ele precisa se identificar no log'
    );
  });

  it('cargo válido sem a capability nega por not_granted', () => {
    const d = perms.decide('moderator', 'identity.reveal');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, perms.DENIAL.NOT_GRANTED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A matriz de cargos, escrita à mão
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `true` = o cargo PODE. Escrita à mão de propósito: derivá-la de
 * `ROLE_CAPABILITIES` faria o teste concordar consigo mesmo, que é o formato
 * mais caro de teste inútil.
 *
 * Mudou aqui? Você está mudando a autoridade da staff no servidor inteiro —
 * jogo, painel e bot de uma vez. Diga o porquê no corpo do commit.
 */
const MATRIZ = {
  //                     moderator  admin  owner
  'players.kick':      { moderator: true,  admin: true,  owner: true },
  'players.teleport':  { moderator: true,  admin: true,  owner: true },
  'players.animate':   { moderator: true,  admin: true,  owner: true },
  'whitelist.view':    { moderator: true,  admin: true,  owner: true },
  'whitelist.review':  { moderator: true,  admin: true,  owner: true },
  'characters.view':   { moderator: true,  admin: true,  owner: true },
  'audit.view':        { moderator: true,  admin: true,  owner: true },
  'governance.view':   { moderator: true,  admin: true,  owner: true },
  'voice.mute':        { moderator: true,  admin: true,  owner: true },
  'server.view':       { moderator: true,  admin: true,  owner: true },

  // Morte permanente nunca é decisão de linha de frente.
  'characters.retire': { moderator: false, admin: true,  owner: true },
  // Nem furar o anonimato: é a única ação de staff que não se desfaz.
  'identity.reveal':   { moderator: false, admin: true,  owner: true },
  'inventory.grant':   { moderator: false, admin: true,  owner: true },
  'economy.adjust':    { moderator: false, admin: true,  owner: true },
  'economy.recipes':   { moderator: false, admin: true,  owner: true },
  // Uma das duas ferramentas ESCREVE no ator alvo.
  'world.probe':       { moderator: false, admin: true,  owner: true },
  // O ranking de patrimônio é metagaming pronto na mão do cargo mais numeroso.
  'economy.view':      { moderator: false, admin: true,  owner: true },
  // Crash reports carregam Discord ID e username de cada jogador que crashou.
  'security.view':     { moderator: false, admin: true,  owner: true },
  // Bypass da governança IC em todo escopo, o tempo todo.
  'staff.manage':      { moderator: false, admin: false, owner: true },

  // Profissão é poder econômico/RP, não moderação de presença — mesma classe
  // de decisão que economy.adjust, então fora do moderador pelo mesmo motivo.
  'profession.view':    { moderator: false, admin: true, owner: true },
  'profession.assign':  { moderator: false, admin: true, owner: true },
  'profession.revoke':  { moderator: false, admin: true, owner: true },
  'profession.rank':    { moderator: false, admin: true, owner: true },
  'profession.xp':      { moderator: false, admin: true, owner: true }
};

describe('matriz de cargos', () => {
  for (const [capability, esperado] of Object.entries(MATRIZ)) {
    for (const cargo of CARGOS) {
      it(`${cargo} ${esperado[cargo] ? 'PODE' : 'NAO PODE'} ${capability}`, () => {
        assert.equal(
          perms.roleHasPermission(cargo, capability), esperado[cargo],
          `Se a intenção era mudar quem pode '${capability}', atualize a MATRIZ neste arquivo — ` +
          `e saiba que a mudança vale no jogo, no painel e no bot ao mesmo tempo.`
        );
      });
    }
  }

  it('a matriz cobre toda capability ativa', () => {
    const ausentes = perms.activePermissions().filter((nome) => !(nome in MATRIZ));
    assert.deepEqual(
      ausentes, [],
      `Capability(ies) ativa(s) fora da matriz: ${ausentes.join(', ')}. ` +
      `Toda capability nova entra aqui — senão ela nasce sem ninguém verificando quem pode usá-la.`
    );
  });

  it('a matriz não inventa capability que o catálogo não tem', () => {
    const inventadas = Object.keys(MATRIZ).filter((nome) => !perms.CAPABILITIES[nome]);
    assert.deepEqual(inventadas, [], `Na matriz e fora do catálogo: ${inventadas.join(', ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Compatibilidade: nenhum sítio de chamada existente pode ter quebrado
// ─────────────────────────────────────────────────────────────────────────────

describe('nomes legados continuam valendo', () => {
  it('todo alias aponta para uma capability que existe', () => {
    for (const [antigo, novo] of Object.entries(perms.LEGACY_ALIASES)) {
      assert.ok(
        perms.CAPABILITIES[novo],
        `alias '${antigo}' aponta para '${novo}', que não está no catálogo`
      );
    }
  });

  it('os 13 nomes do sistema anterior estão todos cobertos', () => {
    // A lista é literal de propósito. Derivá-la de `LEGACY_ALIASES` provaria
    // que o objeto tem as chaves que tem.
    const anteriores = [
      'kick', 'teleport', 'view_audit', 'manage_whitelist', 'ban', 'add_item',
      'set_gold', 'manage_staff', 'retire_character', 'manage_recipes',
      'reveal_identity', 'run_world_probe', 'voice_mute'
    ];
    for (const antigo of anteriores) {
      assert.ok(
        perms.LEGACY_ALIASES[antigo],
        `'${antigo}' era uma permissão do sistema anterior e não tem tradução. ` +
        `Todo sítio de chamada que a usa passou a negar em silêncio.`
      );
    }
  });

  it('o cargo owner mantém, pelos nomes antigos, tudo que tinha', () => {
    // Exatamente a asserção que `permissions.behavior.test.js` já fazia — aqui
    // contra o catálogo, para que uma mudança de vocabulário não possa remover
    // poder por acidente de tradução.
    for (const antigo of ['kick', 'teleport', 'add_item', 'set_gold', 'retire_character', 'manage_staff', 'reveal_identity']) {
      assert.equal(perms.roleHasPermission('owner', antigo), true, `owner perdeu '${antigo}'`);
    }
  });

  it('`ban` nega agora, porque nunca teve porta', () => {
    // Era concedida a admin e owner e verificada em lugar nenhum. Traduz para
    // uma reservada: o resultado prático é o mesmo de antes (nada acontecia),
    // e agora ele é declarado em vez de acidental.
    const d = perms.decide('owner', 'ban');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, perms.DENIAL.RESERVED_PERMISSION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Varredura: toda capability ATIVA tem um sítio de chamada de verdade
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A guarda que teria pego o `ban`.
 *
 * `permissions.behavior.test.js` garante que todo handler exportado está na
 * matriz. Esta varredura garante o inverso: que toda permissão declarada como
 * ativa é de fato exigida em algum lugar do código de produção.
 *
 * Aceita o nome novo **ou** o alias legado, porque a migração é deliberadamente
 * incremental: `crafting-service.js` continua pedindo `manage_recipes`, e
 * obrigá-lo a mudar no mesmo commit reintroduziria risco num módulo PARKED que
 * ninguém está olhando — que é exatamente onde o último bug de permissão morou.
 */
describe('nenhuma capability ativa é uma porta que não leva a lugar nenhum', () => {
  const RAIZ = path.resolve(__dirname, '..', '..', '..');
  const IGNORAR = new Set(['node_modules', '.git', 'artifacts', 'dist', 'generated-images', 'crash-reports']);

  function varrer(dir, acc) {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORAR.has(entrada.name)) continue;
      const alvo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) { varrer(alvo, acc); continue; }
      if (!/\.(js|mjs|ts)$/.test(entrada.name)) continue;
      // Testes não contam como ponto de aplicação: um teste que cita o nome
      // provaria só que o teste existe. É o catálogo sendo verificado contra o
      // código de produção, e só ele.
      if (/\.test\.(js|mjs|ts)$/.test(entrada.name)) continue;
      if (alvo.includes(path.join('core', 'permissions.js'))) continue; // o próprio catálogo
      acc.push(fs.readFileSync(alvo, 'utf8'));
    }
    return acc;
  }

  const fontes = varrer(RAIZ, []).join('\n');

  for (const capability of perms.activePermissions()) {
    it(`'${capability}' é exigida em algum lugar do código`, () => {
      const alias = Object.keys(perms.LEGACY_ALIASES).find((k) => perms.LEGACY_ALIASES[k] === capability);
      const achouNova = fontes.includes(`'${capability}'`) || fontes.includes(`"${capability}"`);
      const achouLegada = alias ? (fontes.includes(`'${alias}'`) || fontes.includes(`"${alias}"`)) : false;

      assert.ok(
        achouNova || achouLegada,
        `'${capability}' está ATIVA no catálogo e nenhum arquivo de produção a exige` +
        `${alias ? ` (nem pelo nome legado '${alias}')` : ''}. ` +
        `Ou ela ganhou um ponto de aplicação e a busca não achou, ou ela é o próximo 'ban': ` +
        `uma permissão concedida que descreve um poder inexistente. Se o poder ainda não existe, ` +
        `marque-a como 'reserved' e tire-a dos cargos.`
      );
    });
  }
});
