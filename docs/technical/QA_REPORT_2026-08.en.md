# QA report and improvement plan — August 2026

*[Português](QA_REPORT_2026-08.md) · **English** · [Русский](QA_REPORT_2026-08.ru.md) · [Español](QA_REPORT_2026-08.es.md)*

A full sweep of the monorepo: gamemode, web panel, Discord bot, launcher, schema, scripts and documentation. Written after running the existing tests, following every configuration path back to its origin, and checking whether what the documentation claims matches what the code does.

**Method and limits:** everything here was verified by reading code, running automated tests and static checking. **Nothing was validated in a real game session** — no claim about in-game behavior should be taken as tested.

*Updated after the first round of fixes: items marked "fixed"/"resolved" are already in the code; those marked **OPEN** are still pending.*

---

## 1. Status by component

| Component | Tests | Installable | Real state |
|---|---|---|---|
| `skymp/gamemode` | 1270/1270 ✅ + 13/13 system checks | ✅ | **Mature, and now with a real boot behind it.** Atomic transactions, a state machine, a module registry, real test coverage. The second pass (2.16–2.26) found ten defects the suite could not catch — nine of them configuration or lifecycle. The jump from 444 to 1270 is mostly voice (SkyVoice, stages 1–5) and the three frameworks of 13/08. |
| `apps/bot-discord` | 40/40 ✅ | ✅ | **Working**, small scope (role sync + temporary voice channels). |
| `apps/web` | 40/40 ✅ | ✅ | **Working.** Gained smoke tests this round. |
| `apps/launcher` | 74/74 ✅ | ✅ | **Was broken end to end** (see 2.1) and had no tests at all. The modpack parity logic was extracted into `electron/parity.mjs` and tested — it found the extra-plugin hole (2.15). Voice distribution (`electron/voice-dist.mjs`) came later, with a manifest, integrity and rollback. The rest of `main.ts` needs Electron and **has never been executed**. |
| `apps/game-api` | 48/48 ✅ | ✅ | **New.** Serves port 7758, which the launcher always called and which didn't exist. |
| `mp` typings | `npm run typecheck` | — | `skymp/gamemode/types/mp.d.ts` types SkyMP's API (there are no public upstream typings). Informational; it blocks neither build nor tests. It found 2.13 and 2.14 on its first run. |
| Schema / migrations | `npm run check:schema` | — | Consistent **after v9**. The checker found `characters.gold` declared in `schema.sql` and in no migration (2.21) — a fresh database worked, a migrated one did not. |

### What actually runs today

> ⚠️ **Until 2026-08-06 the flags turned nothing on** — the gamemode never loaded its own `.env` (2.16). The server's first real boot happened on 2026-08-06, with four active modules and 33 registered commands.

**Twelve** modules registered in `core/module-registry.js`, all behind an `ENABLE_*` flag and **all off by default**: `interaction`, `npc-cleaner` (core), `death`, `governance`, `market-stalls`, `player-panel`, `soul`, `voip`, `nametag`, `trade`, `fauna-census`, `corpse-probe` (lab). The last two are not mechanics: they are Phase 0 observation instruments for the hostile-mob question — see [`FAUNA_CENSUS_PROTOCOL.md`](FAUNA_CENSUS_PROTOCOL.md).

**Five** services exist on disk and are **never registered** — `economy-regional`, `jobs`, `crafting`, `housing`, `horse` (PARKED). `trade-service` left that list: it has been registered since 2026-08-13, on top of the [Inventory Framework](../framework/INVENTORY_FRAMEWORK.md). Four others were deleted on 2026-08-06 (`economy-service`, `justice`, `faction`, `survival`), and `disguise-service` in a second pass, for duplicating an active system or being unsafe — see `PARKED_SERVICES_DECISION.md`. Those that stayed and touched gold were migrated to `core/transaction-service`.

---

## 2. Findings

### 2.1 🔴 The launcher loaded no configuration at all — *fixed*

`electron/main.ts` read `process.env.VITE_DISCORD_CLIENT_ID`, `VITE_SERVER_IP`, `VITE_API_PORT`, `VITE_GITHUB_DIST_REPO`. **Nothing put those values into `process.env`**: there was no `dotenv`, no `loadEnv`, no `define` in `vite.config.ts`. Vite loads `.env` into `import.meta.env` (renderer), not into the main Node process — and the packaged app has no `.env` beside it.

Consequence: everything fell back to empty/`127.0.0.1`. Discord login impossible (`client_id=''`), server always localhost, updater off. The `.env.example` documented seven variables that never had any effect.

**Fixed:** `vite.config.ts` now uses `loadEnv` + `define` to substitute those accesses at build time, which is the only mechanism that survives packaging.

### 2.2 🔴 Discord client secret embedded in the installer — *fixed*

`VITE_DISCORD_CLIENT_SECRET` was used directly in the `code`-for-token exchange inside the launcher. Fixing 2.1 alone would have **made this worse**: the secret would have been inlined into the bundle and shipped to every player who downloaded the installer.

**Fixed:** the exchange became `POST /api/launcher/oauth/exchange` on the web panel, which already holds the secret. The launcher sends `{code, redirect_uri}` and receives only the public profile — not even the access token. The panel validates `redirect_uri` against an allowlist, with rate limiting.

### 2.3 🔴 Approving a whitelist resurrected a permanently dead character — *fixed*

`PATCH /api/whitelist/:id` ran `UPDATE characters SET status='approved'` joining by account, **without filtering by status**. A player who took a `/permakill` (`status='retired'`), created a new application and got approved had their retired character reverted to `approved` — undoing the consequence and erasing the effect of the audit log.

**Fixed:** `AND c.status='pending'` in the `UPDATE` (and in the `extra_review_notes` one).

### 2.4 🟠 `.env` outside `.gitignore` in two apps — *fixed*

`apps/web` and `skymp/gamemode` had their own `.gitignore` covering `.env`. **`apps/bot-discord` had no `.gitignore` at all** (that's where `DISCORD_BOT_TOKEN` and `INTERNAL_API_SECRET` live) and `apps/launcher` ignored `*.local` but not `.env`. No real `.env` was ever committed, but one `git add .` would have been enough.

**Fixed:** a `.env` / `!.env.example` rule in the root `.gitignore`, covering all four.

### 2.5 🟠 `electron/` was never typechecked — *fixed*

`tsconfig.node.json` included only `vite.config.ts`; `tsconfig.app.json`, only `src`. `npm run build` runs `tsc`, but `tsc` never looked at the main process — and `vite-plugin-electron` uses esbuild, which transpiles without type checking. A type error in `main.ts` (1,200+ lines, the most complex part of the launcher) went straight into the installer.

**Fixed:** `electron` added to the include. The check caught a dead import on its first run.

### 2.6 🟠 Three divergent proximity-range tables — *fixed*

`rp-chat-service.js` (450/1200/1500/2000/3500), `voip-service.js` (200/1200/3000) and `server-options.*.example.json` (350/1400/3000) disagreed. RP effect: someone within range of a **written** whisper was outside range of a **spoken** one — the same act of stepping closer worked or didn't depending on the channel.

**Fixed:** `core/proximity-ranges.js` as the single source; chat, voice and the death-evidence radius all derive from it.

### 2.7 🟠 Dead manifest endpoint with a fake hash — *fixed*

`GET /api/launcher/manifest` on the panel returned `hash: "dummy_hash_for_testing"` and a fake URL. **No code consumed it** — the launcher uses GitHub Releases. Worse: `MANIFEST_VS_NEXUS_COLLECTIONS.md` argued at length about that endpoint as if it were the real mechanism, and credited SHA-256 to a code path that uses MD5.

**Fixed:** endpoint removed; the documentation was rewritten as `LAUNCHER_DISTRIBUTION.md`, describing the channels that actually exist.

### 2.8 🟠 `/api/apply` had no input validation — *fixed*

It accepted an empty name, a one-character biography, or text longer than the column (turning into a 500 with no explanation). The fields the whitelist rubric treats as decisive (motivations, weaknesses, social ties) were `required` in HTML only — trivial to bypass.

**Fixed:** server-side validation with per-field minimums and maximums.

### 2.9 🔴 No server existed on port 7758 — *resolved, with a loose end*

The launcher calls `http://<SERVER_IP>:7758/mods.json` (modpack parity) and `/api/queue/status` + `/api/queue/join` (queue). **No service in this repository listened on that port.**

That means modpack parity verification — the thing that upholds the entire FormID contract and the server-authority rule — **had never run**.

**Resolved:** `apps/game-api` serves all three endpoints, with a manifest generator (`scripts/generate-mods-manifest.js`) and 24 tests. Details in `LAUNCHER_DISTRIBUTION.md`. Along with it came 1.1b: the queue now requires a ticket issued by the panel instead of the `discordId` the client declares.

**Loose end — resolved by the native path:** research into `skymp5-server/ts/systems/login.ts` showed SkyMP already solves this on its own. With `offlineMode: false`, it doesn't read the client's `profileId`: it resolves `gameData.session` against a master API and uses the `id` that comes back.

`apps/web` now serves that contract (`GET /api/servers/:masterKey/sessions/:session`), `apps/game-api` writes the session into `game_sessions` (migration v8) on queue admission, and the launcher already writes the token as `session`. Result: `whitelist.js` needed no change — the `profileId` that arrives **already is** the validated `accountId`.

That made the `/internal/session/resolve` we built redundant. It stays in `game-api` only until in-game testing confirms the native flow.

### 2.10 🟡 `server-options.json` was read by nobody — *partially resolved*

`Initialize-LocalConfig.ps1` generates the file, `SERVER_OPTIONS_SCHEMA.md` documents 112 lines of options, and **no code reads it**. Configuration that appears to exist and does nothing is worse than absent configuration: someone will adjust `permadeathEnabled` or `startingGold` and conclude the server is broken.

**Resolved:** `core/server-options.js` loads, validates and applies it. Eight options are genuinely wired (chat/voice ranges, `oocEnabled`, rate limit, `permadeathEnabled`, `playerRespawnSeconds`, `startingGold`) — the rest stay inert, but the loader now **warns at boot** when it finds one of them in the file, and **aborts the boot** if a value has the wrong type or is out of range.

The principle adopted: only an option that genuinely changes behavior enters `SPEC`. Declaring all 24 and wiring 8 would recreate the same problem, only harder to notice — because then the file *is* read, and the person has less reason to be suspicious. A test prevents the example from gaining a new key without someone classifying it. 18 tests in `core/server-options.test.js`.

### 2.11 🟡 `apps/web` had no dependencies installed and no tests — *resolved*

`node_modules` missing. `Start-AllServices.ps1` only checked that `.env` existed, so the panel died on `require('dotenv')` in a separate window and the orchestration reported success. It was also the only service with business logic (staff authorization, whitelist approval, OAuth exchange) **with no tests at all**.

**Resolved:** dependencies installed; 29 smoke tests in `server.test.js` (auth guard on 12 routes, application validation, `redirect_uri` allowlist, ticket hashing); `Start-AllServices.ps1` now pre-checks input, `.env` and `node_modules` for each service and reports what didn't come up, instead of lying "completed".

### 2.12 🟡 The Discord bot didn't register commands automatically — *resolved*

`/voz-criar` and `/voz-fechar` only existed after running `npm run deploy-commands` by hand. Nothing warned you if that was forgotten; the command simply didn't appear in Discord.

**Resolved:** `deploy-commands.js` became a module and runs on the bot's `ready` event. A failure there **doesn't take the bot down** — whitelist sync is the critical function and works without the voice commands — but it shouts in the log saying exactly what won't appear. It still works standalone (`npm run deploy-commands`), where it does exit with an error code. 6 new tests.

### 2.13 🔴 Two incompatible ways of calling Papyrus — *resolved by upstream evidence*

Found while typing the `mp` API (`skymp/gamemode/types/mp.d.ts`). The `self` parameter of `mp.callPapyrusFunction('method', ...)` was passed two different ways in the same codebase:

| Form | Where |
|---|---|
| `{ type: 'form', desc: mp.getDescFromId(actorId) }` | `death-service.js`, `player-panel-service.js` — **2 files** |
| raw `actorId` (a `number`) | **22 places**, including `core/transaction-service.js`, `inventory-service.js`, `npc-cleaner.js`, `governance-service.js`, `market-stalls-service.js` |

Both were born in the **same commit** (`82625d2`, 2026-07-11): there was no migration from one to the other, it's inconsistency from the origin. SkyMP's documentation doesn't specify the format, and neither form had been exercised in game.

**Why it's serious:** if only the object form is valid, 22 calls fail silently — and among them is item delivery in `core/transaction-service.js`. The database would record the transaction correctly and the player's inventory would stay empty. The same goes for NPC removal (`npc-cleaner`), inventory sync on spawn (`inventory-service`) and governance handcuffs (`SetActorValue SpeedMult`).

**Resolved:** upstream research found `misc/tests/` — nine integration tests that run against a real server. **All of them use the object form, exclusively**, including for arguments that are references. This stopped being guesswork.

The 22 calls were converted, with a helper (`core/papyrus.js`: `actorRef`/`baseRef`) to avoid repeating the construction. The existing tests never exercised those paths (the mocks don't define `mp`, so the `typeof mp === 'undefined'` guards protected them) — which is why `core/papyrus.test.js` now inspects the **argument** passed, not just the result. 5 new tests.

Confirming in game is still worth doing, but now as a check, not an investigation.

### 2.14 🟡 PARKED modules call `hasPermission` with a number — *resolved at the root*

`admin-service.hasPermission(actorId, permission)` does `staff.permissions.has(permission)`, where `permissions` is a `Set` of **strings**. Twelve calls pass a number (staff level: `10`, `20`):

`crafting-service` (2), `disguise-service` (1), `economy-regional` (1), `faction-service` (4), `justice-service` (4)

`Set.has(20)` on a Set of strings is always `false`, so **every** permission check in those modules always denies. There's no impact today — all five are PARKED — but it means they're more broken than "merely unregistered": flipping the flag wouldn't make them work, it would just block every staff action inside them.

**Resolved:** rather than patching 12 calls in code that doesn't run, `hasPermission` now validates its own argument. A numeric level or an unknown permission name now **denies and logs an error** with the list of what's valid.

Deliberate choice not to throw: that would kill the player's command over a programming mistake. Denying is the safe outcome; the log is what makes someone fix it. It also catches the opposite case — someone writing `hasPermission(id, 'manage_factions')` thinks they created a rule and actually created a door that never opens. 4 new tests.

**Closed at the root and at the leaves on 2026-08-07.** The twelve calls are gone: `disguise-service`, `faction-service` and `justice-service` were deleted, and the three that remained (`/addrecipe`, `/addingredient`, `/settax`) moved to named permissions — `manage_recipes` (new) and `set_gold`. The reasoning behind which permission each command requires is in [§7.4 of `PARKED_SERVICES_DECISION.md`](PARKED_SERVICES_DECISION.md); a static sweep in `parked-staff-permissions.test.js` fails if any production file in the gamemode goes back to passing a number.

---

## 2-bis. Second pass (2026-08-06/07)

The first pass read code. This one **installed the server and turned it on**, and the difference shows in which defects each finds: nine of the ten below are configuration or lifecycle — the class no unit test touches, because there is nothing to test in a file nobody reads.

### 2.15 🔴 A client with an extra plugin passed the parity check — *fixed*

Found while extracting the launcher logic for testing. Both parity checks walked **the server's list** asking "does the player have this?". Neither walked the player's list asking "does the server know about this?".

Consequence: a client with **all** the right mods, with the right hash, **plus one extra `.esp`**, passed both. And one extra plugin in the load order occupies an index and shifts every following one — the `HeavyRP.esm` that is `02` on the server becomes `03` there, and **every `base_id` stored in the database starts pointing at a different record on that player's screen**.

This is exactly the failure the FormID contract exists to prevent (`MODS_AND_GAMEMODE_CONTRACT.md` §3), and it produces no error at all: it produces a chest with something else inside.

A second case came with it: when the server did not report a load order, the code fell back to the **local** one — comparing the player against themselves and always answering `ok`. The worst possible answer, because it looks like approval.

**Fixed:** logic extracted into `apps/launcher/electron/parity.mjs` (no `fs`, no `http`, no `electron`), with 24 tests. The check now runs in both directions, uses `plugins.txt` to know what is actually enabled (a plugin present but disabled shifts nothing), and a missing load order now **fails**.

### 2.16 🔴 The gamemode never loaded its own `.env` — *fixed*

`dotenv` was in `dependencies`, `.env.example` existed, and both `CONTRIBUTING.md` §1 and `FASE_0_ROTEIRO.md` told you to fill in `skymp/gamemode/.env`. **No gamemode file called `require('dotenv')`** — the one reading that file was `apps/web/server.js`, for itself, which is what made the failure invisible.

Effect: `module-registry.bootAll()` saw `process.env[ENABLE_*]` always undefined, so governance, stalls, death, panel and VOIP stayed permanently off. No error — the log said `DESATIVADO (... not defined)`, exactly what it would say if someone had chosen to turn them off.

The `flags de ambiente` check passed the whole time because it only verified the string existed in `.env.example`: it proved someone wrote the line, not that turning the line on did anything.

### 2.17 🔴 Staff rank survived disconnect — *fixed*

`admin-service.removeStaffRole` existed, was exported and had tests, and **no production path called it**. The cache is keyed by `actorId`, which SkyMP reuses across sessions, and `registerStaffRole` only runs at login: whoever landed on a departed admin's `actorId` inherited `ban`, `set_gold` and `retire_character`.

It never showed up in a permission test because the rank was correct at both moments — the defect was about sessions, not authorization.

### 2.18 🔴 `npc-cleaner` deleted vital NPCs, and implemented the rejected option — *fixed*

It swept `mp.getActorsByProfileId(0)` and called `disable` **and `delete`** on every actor, skipping only those in an allowlist — which was empty. Merchants, guards and quest NPCs, every 60 s, and `delete` on a persistent reference does not come back.

`NPC_POLICY_DECISION.md` weighed three options and chose **C (Selective Spawn)**; the code implemented B, the rejected one, in its most extreme form. On top of that, `safeRadius` was declared with the comment "only cleans NPCs far from players" and **never read**.

The list became a blocklist (empty = removes nothing), the radius came into existence, and `delete` is gone.

### 2.19 🟠 `/setgold` was the only money path outside the ledger — *fixed*

A bare `UPDATE characters SET gold = ?`, no transaction and no row in `gold_transactions` — the very pattern that motivated deleting `economy-service.js`. It is the command that most needs a trail: gold with no recorded origin is indistinguishable from duplication by bug, and the people who can do it are staff.

A missing guard came along: `/setgold <id>` with no value passed `NaN`, which MySQL stores as `0` — a typo silently wiped out a player's fortune.

### 2.20 🟠 Stall purchase reimplemented `transaction-service` — *fixed*

`buyItem` wrote the gold and inventory SQL by hand. It was atomic and ledgered, so not unsafe; it was a second implementation outside the file that exists to be the only one, with `FOR UPDATE` and the negative-balance guard duplicated.

The service's public functions could not solve it (each opens its own transaction, and the purchase must commit stock, gold, tax and item together). The internal primitives — which already took the connection — are now exported as `tx.*`, with an explicit contract.

`buyItem` had **no** behavioural test at all; it gained 10.

### 2.21 🔴 `characters.gold` did not exist in a migrated database — *fixed (migration v9)*

The column is declared in `schema.sql` and in **no migration**. A fresh database works; anyone who created theirs before the column and applied `v2`→`v8` in order, as CONTRIBUTING instructs, never gets it. v2 even creates `gold_transactions` — the ledger — without guaranteeing the balance column it tracks.

It does not break the boot: it breaks on the first gold operation, which is all of `transaction-service`. In the Phase 0 script the test would die at **step 5.6**, after five steps went right, with two people and Skyrim open.

Found by `npm run check:schema` (plan item 4.1) — precisely the class of problem it was written for.

### 2.22 🟠 `core/soul.js` held two invisible characters that carried meaning — *fixed*

The file counted as binary to `grep` and to `file`. The cause was not the obvious one: besides the raw combining-marks class in `normalize()`, there was a **NUL byte** in the separator of the signed material, which reads on screen as `].join('')`.

NUL is the **right** choice (it does not survive `normalize()`, so no player can type it into an application; with a typeable separator, `'ab'+'c'` and `'a'+'bc'` would sign the same material and two different applications would be born with the same soul). The problem was that it was invisible: any editor that strips control characters on save would change the seed of **every soul already derived**.

Verified that the seeds did not change, and the derivation gained a golden-value test.

### 2.23 🔴 Two defects only the first real boot revealed — *fixed*

**`Cannot find module 'dotenv'`, and the gamemode did not load.** SkyMP copies the entry file to `%TEMP%` and runs it from there — this is written at the top of the file itself, and it is why every require in it uses an absolute path. The dotenv one, added while fixing 2.16, was the only bare specifier, and a bare specifier resolves from the directory of the running file.

It passed 366 tests and CI because both run from `skymp/gamemode/`. **It is the cleanest example of what the `ci.yml` header already warned about:** *"a green CI means you did not break what was already verified, not that it works in game"*.

**No gameplay option was being read.** `.env.example` set `NODE_ENV=development`, the loader builds `server-options.<NODE_ENV>.json`, and the project only ships `local` and `production`. Changing `permadeathEnabled`, the chat ranges or `startingGold` did nothing.

### 2.24 🟡 `database.js` had no `close()` — *fixed*

`verify-governance-market-stalls.js` already called `db.close()` behind a guard, and the function never existed: the guard never fired and the mysql2 pool held the event loop. `RUN_DB_CHECK=1 npm run test:systems` printed `10/10 passed` and **hung forever** (exit 124 by timeout; now exit 0). In a CI with a database, the job would only end at the timeout and the report would say "cancelled".

### 2.25 🟠 A PARKED module could be enabled around the registry — *fixed*

`governance-service` decided whether `economy-regional` runs by reading `process.env.ENABLE_REGIONAL_ECONOMY` directly, in two places: the flag alone was enough to load and **execute** a parked module with no dependency resolution, no command registration and no shutdown. `CONTRIBUTING.md` §3.3 forbids exactly this, and so does this report's own "Do not do" section.

### 2.26 🟡 The `mods.json` generator had no test — *fixed*

Being the thing that decides the FormID contract — the one that, when wrong, produces no error: it produces a chest with something else inside. It gained 6 tests and the `--only-load-order` flag, which makes it possible to run Phase 0 before the modpack exists: without it, generating the manifest from a working `Data/` produces a file that demands the generating machine.

---

## 2-ter. Harvesting the Red House (2026-08-06/07)

The four items `REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1 (Portuguese) listed as worth taking have been implemented. **In three of them the real server was probed before writing** — assuming an API shape is what caused 2.13 and 2.23.

| Item | What changed | Status |
|---|---|---|
| Panel polling | Read 3 ActorValues per open panel every 2 s, including for someone sitting on the Social tab (~450 ms per window with 10 panels). The UI already sent the active tab and the server discarded it | ✅ |
| `isInSafeLocation` | `action-policy` now blocks by **place**, not only by state. The both-sides rule came with it | ✅ mechanism; the zone list is born empty (Constitution §15) |
| `lookupEspmRecordById` | Validates `base_id` against the loaded plugins, in `/additem` and in stall listing | ✅ shape confirmed by probe |
| `_onHit` | Client-reported aggression becomes combat evidence, replacing the damage-spike heuristic | ✅ registered; **client snippet awaits Phase 0** |

**One deliberate difference from them:** the Red House recomputes damage from the hit event and applies it. We do not — the machine sending the event is the player's, and `CONTRIBUTING.md` §3.6 is explicit that a client event is a hint, not proof. It becomes evidence for RDM arbitration, and the stored row states where it came from.

**A licence correction:** §4.1 of the study claimed "GPL-3.0 — you cannot copy code". That was wrong, and `LICENSE_AND_AFFILIATION_POLICY.md` §4 already said the opposite: we are `AGPL-3.0-or-later`, GPLv3 §13 permits the combination, and code from there can be reused with attribution. The error pushed towards rewriting from scratch what could have been ported.

---

## 3. Improvement plan

Ordered by **what unblocks what**. Phase 1 items are prerequisites for any test with real players.

### Phase 1 — Close the path to "two players connected"

| # | Item | Why |
|---|---|---|
| 1.1 | ✅ **Done** — `apps/game-api` serves `/mods.json`, `/api/queue/join` and `/api/queue/status` | |
| 1.2 | ✅ **Done** — `apps/game-api/scripts/generate-mods-manifest.js` | |
| 1.3 | ✅ **Done** — `Start-AllServices.ps1` pre-checks each service and reports what didn't start | |
| 1.4 | ✅ **Done** — 29 smoke tests in `apps/web/server.test.js` | |
| 1.5 | **Run the [Phase 0 runbook](FASE_0_ROTEIRO.md)** (Portuguese) — step by step, ~50 min, 2 people | The whole gamemode is verified only by unit tests against a mocked `mp`. **This is the real remaining blocker.** |
| 1.5a | ✅ **Resolved without a server** — SkyMP's own tests answered it. The 22 calls were converted. Confirming in game still counts, but as a check, not an investigation | |
| 1.6 | ✅ **Done** — `apps/web` serves the master API, `game_sessions` (v8) stores the session, `offlineMode: false` in the examples. In-game confirmation still pending | |
| 1.7 | ✅ **Done** — `mp.onDeath` is the primary trigger and attribution goes to `audit_logs` (`death:killer`). Polling stays as a safety net until the hook is confirmed in game | |
| 1.8 | **Remove the `death-service` polling entirely** once `onDeath` is confirmed in game | This stopped being about elegance: Red House measured ~15 ms per Papyrus round-trip (`REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1). Our loop sweeps up to 50 profileIds every 2s — with 40 players that eats ~600 ms of every window, synchronously. It doesn't scale. Worth reviewing `player-panel-service` for the same reason. |

### Phase 2 — Get ghost configuration out of the way

| # | Item | Why |
|---|---|---|
| 2.1 | ✅ **Done** — `core/server-options.js` with 8 wired options, validation that aborts the boot, and a warning for the inert ones | |
| 2.2 | ✅ **Done** — registration on the bot's `ready`, without taking the process down on failure | |
| 2.3 | ✅ **Done** — four deleted (`economy-service`, `justice`, `faction`, `survival`), seven kept as PARKED. Recorded in `PARKED_SERVICES_DECISION.md` | The most urgent was `economy-service.js`: it touched gold without atomicity or a ledger, and 6 PARKED modules imported it — reactivating any of them would have brought the unsafe economy along. The importers were migrated to `core/transaction-service` **before** removal. |
| 2.4 | ✅ **Decided** — keep and document them as reserved (`ARCHITECTURE.md` 1.1). An empty table has no execution path and duplicates no logic; the cost of removing would exceed the gain | |

### Phase 3 — Harden for production

| # | Item | Why |
|---|---|---|
| 3.1 | ✅ **Done** — `PANEL_PUBLIC_URL` (accepts a list) defines the CORS origin and the callback fallback | |
| 3.2 | ✅ **Done** — pruning by age **and** by count (`CRASH_REPORT_MAX_AGE_DAYS`/`MAX_FILES`), triggered after each receipt | Two limits because a crash loop generates hundreds of reports on the same day, and age alone wouldn't hold. |
| 3.3 | ⚙️ **Configured, certificate missing.** `win.signtoolOptions` and the `release-launcher.yml` workflow exist and actually verify the signature (`Get-AuthenticodeSignature` must return `Valid` **and** a timestamp); no signed installer has been produced, because there is no certificate. See [`LAUNCHER_DISTRIBUTION.md` §6](LAUNCHER_DISTRIBUTION.md). | Without a signature, SmartScreen blocks it and the player does not install. What is left are two human steps: buying the certificate (§6.3 compares OV, EV and Azure Trusted Signing) and confirming SmartScreen by hand on a clean machine — reputation is built by Microsoft across real downloads and is not automatable. |
| 3.4 | ✅ **Done** — migration v7. Along with it: `DATE(created_at)=CURDATE()` in the dashboard became a range comparison, because wrapping the column in a function prevents index use | |

### Phase 4 — Maintenance (added 2026-08-06)

Came out of the integration study with Chancelaria Real, a system running in production with practices that were missing here. Depends on no in-game test and no integration.

| # | Item | Why |
|---|---|---|
| 4.1 | ✅ **Done** — `npm run check:schema` compares the live database against the migrations | A half-migrated database doesn't break the boot; it breaks the query touching the missing column, weeks later. |
| 4.2 | ✅ **Done** — `permissions.behavior.test.js`, a role × command matrix against the real handlers | The `Set.has(20)` bug went through the whole unit suite. This is the class it belongs to. |
| 4.3 | ✅ **Done** — `identity-service` tests (the disguise firewall) | The system deciding who recognizes whom had no tests. Leaking the civil name kills the disguise with no error at all. |
| 4.4 | ✅ **Done** — [OPERATIONS.md](OPERATIONS.md) (Portuguese) | There was a QA report and nothing about operations. |

### Do not do

- **Migrate the manifests to the Nexus Collections format.** See `LAUNCHER_DISTRIBUTION.md` §5 — Collections doesn't guarantee load order parity, which is the reason the manifests exist.
- **Chase native VOIP before the rest.** Still holds — **but the reason changed on 2026-08-07, and the old one no longer applies.** It no longer depends on a client patch: capture moved out of the browser into a native helper, which **compiled and captured real audio** (`VOICE_NATIVE_HELPER.md` §8.3 and §8.4). What remains is that nobody has listened to the audio with their ears (§8.2), that raw PCM costs ~1 Mbit/s upstream per speaker — bench, not production —, and that Phase 0 is still the real blocker. Discord voice channels remain the Alpha solution.
- **Reactivate a PARKED module without going through `module-registry`.** The registry is what guarantees the flag, the dependencies and command cleanup; bypassing it returns the project to the state that produced a good share of the bugs already fixed.

---

## 4. What this report does not cover

- **In-game behavior.** No command (`/painel`, `/socorrer`, `/iniciar`, `/permakill`, `/voz`) has been run in a real session. The tests use a mocked `mp`.
- **Real interaction with the Discord API.** The bot and the new OAuth route were not exercised against a real bot/guild.
- **The packaged launcher build.** The `define` fix was validated by typecheck, not by a generated installer.
- **Load.** No measurement with multiple players, which is where the 2s polling in `death-service`/`player-panel`/`voip` tends to show up first.
