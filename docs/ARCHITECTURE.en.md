# System architecture (SkyMP Heavy RP)

*[Português](ARCHITECTURE.md) · **English** · [Русский](ARCHITECTURE.ru.md) · [Español](ARCHITECTURE.es.md)*

The SkyMP Heavy RP server runs on a distributed architecture, separating critical services to guarantee security, stability and strict adherence to the rule of **Server Authority**.

## 1. Server topology

The infrastructure splits into the following modules:

### 1.1 Database (MariaDB/MySQL)
**MariaDB** is the absolute source of truth. Every service connects to it.
- **Main tables:** `accounts`, `characters`, `character_inventory`, `audit_logs`, `whitelist_applications`, `staff_roles`, `factions`, `holds`, `properties`, `market_stalls`, `crafting_recipes`, `crafting_ingredients`. The full schema lives in `skymp/packages/database/schema.sql` plus migrations `v2`–`v16`, applied **in order** (v6 = `launch_tickets`, v7 = hot-query indexes, v8 = `game_sessions`, v9 = `characters.gold`, v10 = Soul Affinity, v11 = institutional treasury ledger, v12 = regional market ledger, v13 = market-stall sale idempotency, v14 = Inventory Framework, v15 = Economy Framework, v16 = staff voice mute that survives a restart).
- Some tables exist in the schema but aren't read by any active code (`store_purchases`, `trade_routes`, `magic_licenses`, `magic_violations`, `character_diseases`, `staff_permissions`) — they belong to PARKED modules (see 1.4).
- **Strict rule:** no game state change (money, positions, items) happens without being written to or read from MariaDB. Node.js does not trust loose in-memory data over long stretches without persistence.

### 1.2 Web app and API (`apps/web`)
Built with **Express.js / Node.js**.
- Serves the web panel (whitelist, staff, out-of-game profiles).
- Serves the **launcher** the Discord OAuth exchange (`POST /api/launcher/oauth/exchange`, which also issues the launch ticket) and receives crash reports. The mods manifest does **not** come from here — it comes from `apps/game-api` and GitHub Releases (see 1.3.1 and `LAUNCHER_DISTRIBUTION.md`).
- Authentication is mandatory, via `passport-discord`.
- Not to be confused with the **in-game player panel** (see 1.4.2), which runs inside SkyMP's own HUD, not in a browser.
- **Character application** (`/api/apply`, `apply.html`): besides name and biography, it collects `motivations`/`weaknesses`/`social_ties` (the Heavy RP whitelist rubric — see `SKYMP_RP_DEVELOPMENT_PLAN.md` §8.1). A keyword heuristic (`detectsStrongConcept` in `server.js`) flags `characters.needs_extra_review` for strong concepts (nobility, vampirism, lycanthropy, Daedra, faction leadership) — it isn't an automatic gate, just a signal for staff to look harder; staff can attach `extra_review_notes` through the panel (`PATCH /api/whitelist/:id`). `skymp/gamemode/whitelist.js` reads `characters` with `ORDER BY id DESC LIMIT 1` when releasing spawn.

### 1.2.1 Master API (SkyMP's contract, served by `apps/web`)
`GET /api/servers/:masterKey/sessions/:session` → `{ user: { id, discordId } }`

We did not invent this endpoint: it's what the SkyMP server calls when `offlineMode: false` (see `skymp5-server/ts/systems/login.ts` upstream). The `user.id` we answer with **becomes the gamemode's `profileId`**.

This is the piece that takes identity out of the client's hands. With `offlineMode: true`, the client declares its own `profileId` in `skymp_config.json` and the server believes it — anyone edits the file and becomes someone else. With `offlineMode: false`, the `profileId` comes from here, from the same service that authenticated Discord and approved the whitelist.

SkyMP's default `master` is `https://gateway.skymp.net`; pointing it at our panel is one string in `server-settings.json`. `masterKey` must match on both sides (`MASTER_KEY` in the panel's `.env`).

Sessions live in `game_sessions`, stored as a SHA-256 hash, with `expires_at`, `revoked_at` (immediate ban without waiting for TTL) and `resolve_count` (a high count suggests a session shared across machines).

### 1.3 Discord bot (`apps/bot-discord`)
Built with **discord.js**.
- Bridges the user's Discord account to their in-game `profileId` (`POST /api/sync-role`, called by the web panel on whitelist approval/rejection).
- **Temporary voice channels** (`voiceChannels.js`, commands `/voz-criar <name>` and `/voz-fechar`, staff-only): a practical voice alternative while nobody has yet heard native in-game VOIP (`/voz`, see 1.4.4). The client patch that existed for it was **discarded** (`docs/technical/VOICE_CLIENT_PATCH.md`); the capture path that exists today is the native WASAPI helper outside CEF (`docs/technical/VOICE_NATIVE_HELPER.md`), and the overall state of voice is in `docs/technical/SKYVOICE_PRODUCTION_READINESS.md`. A channel is deleted automatically ~30s after going empty. Commands are registered at bot boot (`deploy-commands.js` runs on the `ready` event); a failure there doesn't take the bot down, but it shouts in the log. `npm run deploy-commands` still exists for manual runs.
- **Moderation log** (`moderationLog.js`, internal endpoint `POST /api/moderation-log`): posts an embed to a configurable channel (`MODERATION_LOG_CHANNEL_ID`) on every moderation action. It was the original intent recorded here and went years without an implementation; it landed on 2026-08-07.

  **The channel is not the record - it is a notification.** The record is still `audit_logs`, written by the gamemode and by the panel in the same flow as the action, before anything leaves for Discord. That distinction decides the failure behaviour: if Discord is down, the moderation action happens anyway, nothing is undone and nothing gets slower. The endpoint answers **202 before** talking to Discord, and no producer awaits the send.

  | Event | Producer | Source |
  |---|---|---|
  | `kick` | `admin-service.kickPlayer` (`/kick`) | `gamemode` |
  | `permakill` | `admin-service.retireCharacter` (`/permakill`) | `gamemode` |
  | `whitelist_approve` / `whitelist_reject` / `whitelist_reset` | `apps/web` `PATCH /api/whitelist/:id` | `painel` |
  | `ban` | **none** - see below | - |

  **`ban` is declared and has no producer.** `ban` is a permission granted by the `admin` and `owner` roles in `admin-service.js` that **no command consumes**: there is no `/ban` in the gamemode nor in the panel. The event type stays declared (with a test locking its shape) so that the day the command exists it costs one line - but the log does not invent an action the server does not have.

  **Why push and not polling `audit_logs`.** The bot has `mysql2` in `dependencies` without using it, so reading the table was possible. Discarded: it would hand database credentials to a third process to read what it does not write, in exchange for polling latency. The push leaves from where the action happens, and the only secret crossing is the `INTERNAL_API_SECRET` the panel already shares with the bot. The gamemode uses core `http.request` instead of `fetch` - the Node version embedded in SkyMP is not under our control, and global `fetch` only exists from Node 18 on.

  **An empty channel disables the send.** Without `MODERATION_LOG_CHANNEL_ID` the endpoint still answers 202 and posts nothing; without `BOT_INTERNAL_URL`/`INTERNAL_API_SECRET` in the gamemode `.env`, the gamemode does not even try. A server that does not want the channel pays nothing and sees no error. The channel must be staff-private: the embeds carry kick reasons and whitelist review notes.

  Tested with `discord.js` mocked (21 tests), in the same pattern as the 19 that already existed. Not covered: posting to a real channel, which needs a real bot and guild.

### 1.3.1 Game API (`apps/game-api`)
Express, port `GAME_API_PORT` (7758) — the port the launcher always called and for which no server existed. Details in `docs/technical/LAUNCHER_DISTRIBUTION.md`.
- **`GET /mods.json`**: modpack parity manifest (`{mods, loadOrder}`), generated offline by `scripts/generate-mods-manifest.js` from a reference `Data/` folder. A missing or corrupt manifest answers **503**, never an empty list — an empty list would pass the launcher's verification and let any modpack in.
- **Queue** (`POST /api/queue/join`, `POST /api/queue/status`): fixed capacity, FIFO, with reservation expiry so that someone who closes the launcher after being admitted doesn't hold the slot forever. Authenticated by a single-use ticket issued by the panel (`launch_tickets`, migration v6) — `discordId` is public and is not proof of identity.
- **Game session**: on admitting someone, it writes a row in `game_sessions` (migration v8) and returns the token to the launcher, which writes it as `session` in `skymp_config.json`. That token is what the SkyMP server resolves against the master API (see 1.2.1) — that's how identity stops being a client declaration.
- **`POST /internal/session/resolve` / `/release`** (`X-Internal-Secret`): slot release on disconnect. `resolve` became redundant once the native session path existed — kept only while in-game testing hasn't confirmed the master API flow.

### 1.4 Native SkyMP server (gamemode)
Located in `skymp/gamemode/`.
- Runs on Node.js using SkyMP's internal libraries (`mp.events`, `mp.players`).
- Handles the player lifecycle: connection, disconnection, spawn, combat, chat commands and real-time item persistence.
- Delegates business rules to the services active today (`governance-service.js`, `market-stalls-service.js`, `death-service.js`, `player-panel-service.js`, `voip-service.js`, `soul-service.js`, `trade-service.js`, `nametag-service.js`). **Five** other services exist on disk (`economy-regional.js`, `crafting-service.js`, `jobs-service.js`, `housing-service.js`, `horse-service.js`) but are **PARKED** — never registered in `core/module-registry.js`, therefore never running in production (see the comment in `phase0-basic.js`). `trade-service` left that list on 13/08/2026, when it started running on top of the Inventory Framework (`docs/framework/INVENTORY_FRAMEWORK.md`). Five others (`economy-service`, `justice-service`, `faction-service`, `survival-service`, `disguise-service`) were **deleted** for duplicating active systems or being unsafe — see `docs/technical/PARKED_SERVICES_DECISION.md`.
- Modules are registered and toggled through `core/module-registry.js` (`ENABLE_*` flags in `.env`), which also handles inter-module dependencies and automatic command registration in `core/command-registry.js`.
- **Gameplay configuration** comes from `skymp/config/server-options.<env>.json`, loaded and validated by `core/server-options.js`. Only the options listed in that file's `SPEC` take effect — the loader warns at boot if it finds an option not yet implemented, and **aborts the boot** if a value has the wrong type or is out of range. See `docs/technical/SERVER_OPTIONS_SCHEMA.en.md`.
- **Soul Affinity domain** in `core/soul.js` — generator with a fixed budget, bands, a seed derived from the approved application, and resolution into four outcomes. It is a **pure function**: no database, no `mp`, no side effects. That is exactly why it exists ahead of the service — it is provable outside the server, and it is where being wrong costs the most later. Design in [`docs/design/SOUL_AFFINITY.md`](design/SOUL_AFFINITY.md) (Portuguese); the **service** that talks to the world (signs, marks, tree) is still blocked by in-game testing.
- **`mp` API typings**: `skymp/gamemode/types/mp.d.ts` (SkyMP publishes no typings). `npm run typecheck` is informational — the gamemode stays plain JS loaded directly by the server, with no build step.

#### 1.4.1 UI bridge (CEF)
Communication between the gamemode and the CEF UI (`skymp/ui/`) uses two SkyMP properties registered in `phase0-basic.js`:
- **`browserModal`**: channel for one-off modals (e.g. the governance interaction menu). `updateOwner` runs `ctx.sp.browser.executeJavaScript('window.handleServerModal(...)')` on the client.
- **`panelData`**: the player panel's dedicated channel, shaped `{ channel, data }` — the client dispatches to `window.handlePanelData(...)` and each tab (`status`, `governance`, `economy`, `social`) renders its own block.

In the UI→server direction, `mp.onUiEvent` dispatches every event through `core/ui-event-router.js`, which routes by the prefix of `uiEvent.type` (e.g. `governance:*` → `governance-service.js`, `panel:*` → `player-panel-service.js`). New modules that need UI just call `uiEventRouter.register('<prefix>', handler)` in their `initialize()` — there's no need to edit `phase0-basic.js` for each new event type.

Since 2026-08-11, `core/ui-event-gateway.js` owns the global callback and validates envelopes before routing; `core/ui-event-rate-limiter.js` measures and, when configured, limits volume per actor and event type. `core/connection-monitor.js` handles polling, reconnection, and stale whitelist-response invalidation. `core/opaque-credential.js` centralizes opaque credential generation, hashing, and redaction. For the economy, `core/institutional-treasury-service.js` and `core/regional-market-transaction-service.js` keep balance, stock, and ledger changes in one transaction; migration v13 makes market-stall retries idempotent. These boundaries are tested, while PARKED modules remain outside boot.

#### 1.4.2 Player panel (in-game)
`player-panel-service.js` — module `player-panel` (`ENABLE_PLAYER_PANEL_SERVICE`), opened by the `/painel` command. It duplicates no business logic: it only aggregates reads from existing services.
- **Status**: health/magicka/stamina read via `mp.callPapyrusFunction('method', 'Actor', 'getActorValue', ...)` (the same pattern as `death-service.js`), gold via `core/transaction-service.js`, RP state via `core/character-state.js`. Updated by 2s polling while the panel is open, resending only when a value changes.
- **Governance**: `governance-service.getMyGovernanceSummary()`.
- **Economy**: `market-stalls-service.getMyEconomySummary()`.
- **Social**: the character's own `character_known_identities` list.
- UI in `skymp/ui/player-panel.css` / `player-panel.js`, with a visual identity mirroring [Prisma UI](https://prismaui.dev) (black glass card, violet glow, status chip, pill navigation with Elder Futhark runes as each tab's icon).
- **Proactive refresh**: `core/panel-refresh-bus.js` is a decoupled `EventEmitter` — `governance-service.js` calls `panelRefreshBus.requestRefresh(actorId, 'governance'|'status')` after a fine, warrant or arrest, and `player-panel-service.js` (the single subscriber, registered in `initPlayerPanelService`) resends the matching section **only if that player's panel is already open**. It exists so `governance-service.js` doesn't have to depend on `player-panel-service.js` (which already depends on it), without forcing the panel to pop open on the player's screen.
- **Direct action in the Social tab**: each known person has a "Nickname" button that opens an inline mini-form (`skymp/ui/player-panel.js`, `socialRow`/`bindSocialRenameHandlers`) and sends `panel:social:rename` with `{ targetCharacterId, alias }`. `player-panel-service.renameKnownPerson` calls `identity-service.upsertKnownIdentity` directly by characterId — it works even with the target disconnected, since `character_known_identities` doesn't depend on an active actorId.

#### 1.4.3 Death and consequence (`death-service.js`)
Module `death` (`ENABLE_DEATH_SERVICE`), phase `lab`. It exists so that "dying" carries mechanical and social weight rather than being a non-event — a core Heavy RP principle from `SKYMP_RP_DEVELOPMENT_PLAN.md` (§8.1, "Death and Consequences").
- Death → `core/character-state.js` becomes `DOWNED`, which already blocks gameplay/combat/speech through `core/action-policy.js` with no extra work. The primary trigger is the native hook **`mp.onDeath(actorId, killerId)`**, which fires on the frame of death; the 2s polling remains as a safety net while the hook isn't confirmed in a real session (`handlePlayerDowned` is idempotent per character, so both paths together duplicate nothing). **The hook belongs to `core/death-events.js`**, not to `death-service`: a small named bus, modelled on `panel-refresh-bus`, which assigns `mp.onDeath` exactly once and dispatches to named subscribers, each isolated by `try/catch`. It exists because a direct `mp.onDeath = ...` is exclusive ownership — the second module needing the same event would erase the first **silently**, and the polling would mask the loss with a two-second delay. The second consumer is already foreseen (`hunting-service`, see [`HOSTILE_MOB_ACTIVATION_DECISION.md`](technical/HOSTILE_MOB_ACTIVATION_DECISION.md) §7.3).
- **Attribution**: `mp.onDeath` delivers `killerId` — who killed, `0` when there is no author. Written to `audit_logs` as `death:killer` and carried until bleed-out, which happens minutes later. That is attribution, unlike `logDeathContext`'s proximity, which is circumstantial: in a five-person brawl, five names appear and staff decide by eye.
- **Rescue**: `/socorrer <actorId>` (any player, within `RESCUE_RANGE`) cancels the bleeding and stabilizes the target back to `NORMAL` with partial health (`STABILIZE_HEALTH`). Range validated by `core/range-utils.js` (extracted from `governance-service.js`, used by both).
- **Bleed-out**: if nobody rescues within `BLEED_OUT_MS` (4 min), the character becomes `DEAD`, a gold penalty is applied via `core/transaction-service.removeGold` (atomic — never leaves a negative balance), and only then does respawn happen at the usual safe point.
- **Anti-RDM evidence**: at bleed-out, `logDeathContext` writes to `audit_logs` (`action='death:context'`) a snapshot of who was nearby (the same proximity radius as `say` chat) — it's circumstantial, not attribution. Attribution of who killed comes from `mp.onDeath`'s `killerId` (see above); the proximity snapshot stays useful because it shows **who was on the scene**, which is the question staff ask in a group RDM report.
- Every transition (`DOWNED`/rescued/penalized/respawned) calls `panelRefreshBus.requestRefresh(actorId, 'status')`, reflecting in real time in `/painel`.
- **Minimum RP layer for combat**: there is no reliable native hook for "who attacked whom" in this base, so the scope is evidence, not enforcement. `/iniciar <actorId> <reason>` writes an explicit marker of an IC conflict opening to `audit_logs` (`combat:initiate`). In parallel, the same HP polling that detects `DOWNED` also runs `checkDamageSpike` every tick — a health drop `>= DAMAGE_SPIKE_THRESHOLD` (a heuristic, 25 points) in a single 2s tick fires `logDeathContext(..., 'damage_spike')`, creating a proximity trail even when nobody uses `/iniciar`. `core/range-utils.js` gained `nearbyActors()` so the neighbor-scan logic isn't duplicated between death context and damage context.

**Permanent death (soft delete):** `admin-service.retireCharacter(actorId, targetActorId, reason)`, command `/permakill` (permission `retire_character`, tiers `admin`/`owner` only — never moderator). It never does `DELETE` — only `UPDATE characters SET status='retired'`, with a mandatory reason and an audit log. `whitelist.js` only allows spawn with `status='approved'`, so a `retired` character never enters play again without any other change being needed.

#### 1.4.4 Proximity voice (`voip-service.js`)
Module `voip` (`ENABLE_VOIP_SERVICE`), phase `lab`. WebRTC signaling (offer/answer/ICE) over its own WebSocket (port `VOIP_PORT`, default 7778) — the audio itself is P2P between clients after the handshake; the server only exchanges signaling and computes volume by distance every 2s. Ranges come from `core/proximity-ranges.js`, the single source for chat **and** voice — the two tables used to diverge (voice whispered at 200, chat at 450), so the same gesture of stepping close to speak quietly worked or didn't depending on the channel.

**Since 2026-08-07 there is a second path, and it is the one that will stick.** The P2P WebRTC above never produced any audio: the client's CEF refuses `getUserMedia`, and the Chromium flag that used to allow it was *deliberately removed* in SkyrimPlatform 2.1 — reverting it would expose the player's microphone to any SkyMP server they connect to afterwards. A native helper (`voice-helper/`) now captures outside the browser and sends `audio_frame` over the same socket with the same ticket; the server **relays** by proximity with the volume attached, reusing the 2s tick's result, and the browser only plays. This also fixes NAT/CGNAT, which would have blocked the P2P mesh. Both paths coexist: phase 2 removes the old one. See [`technical/VOICE_NATIVE_HELPER.md`](technical/VOICE_NATIVE_HELPER.md).

**Before this revision the feature existed only on paper** — nothing in `phase0-basic.js` called `startVoipServer()`, and the client's `mp.events.add('voip:connect', ...)` listener never fired because no server code does a `mp.trigger`/emit of that event anywhere in the gamemode. It wasn't a visibly broken indicator (the status chip is `display:none` until `setStatus()` runs, and that never happened) — the feature was simply absent, silently.

- **Opt-in via `/voz`** (not forced — and as of 2026-08-07 **native voice is not a launch prerequisite**: the decision is closed in `SKYMP_RP_DEVELOPMENT_PLAN.md` §13, which classifies this module as optional/post-Alpha and points to the Discord voice channels (1.3) as the real solution for Alpha and the closed Beta). The command calls `requestVoiceConnection`, which issues a single-use ticket (`issueTicket`, 30s TTL) and pushes `{actorId, ticket, host, port}` to the client via the `voipTicket` property (the same proven pattern as `browserModal`/`panelData`).
- **Ticket authentication**: the WebSocket handshake (`{type:'auth', actorId, ticket}`) requires the ticket to match what was issued for that `actorId` — without it, any process connecting to `ws://127.0.0.1:7778` could claim another player's `actorId` and hijack their voice slot. The ticket is consumed on first use (replay fails).
- **Dynamic host**: since `skymp/ui/index.html` is a static file with no templating, it can't know the server's public IP on its own — so the server sends `host`/`port` in the ticket payload itself (`VOIP_PUBLIC_HOST`/`VOIP_PORT` in `.env`), instead of the client hardcoding `ws://127.0.0.1:7778` (which only worked with player and server on the same machine).
- `VOIP_BIND_HOST` (default `127.0.0.1`) controls which interfaces the `WebSocketServer` listens on — not to be confused with `VOIP_PUBLIC_HOST`, which is what the client receives in order to connect.
- **The failure path is part of the design, not an afterthought.** On the official client `getUserMedia` returns `NotAllowedError` (see `docs/technical/VOICE_CLIENT_PATCH.md`), and that is what players will hit until the §13 decision is revisited — so it is the common path, not the exception. `skymp/ui/index.html` closes signaling and shows the reason in two places: the status chip (state) and the `chat-log` (the why, pointing to `/voz-criar` on Discord). `onclose` must not overwrite a terminal reason already on screen — on its own it would say "VOZ DESCONECTADA", which reads as server instability and sends the player to file the wrong ticket.

#### 1.4.5 Combat evidence (`core/hit-events.js`)
Not a registry module: it is a layer the `death-service` consumes. It originates from Red House (`docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1), with license attribution in the file header.

- **The mechanism**: `mp.makeEventSource('_onHitReported', <snippet>)` injects a snippet into the client that listens to Skyrim Platform's `ctx.sp.on('hit', ...)` and reports `{target, aggressor, isPowerAttack, isSneakAttack, isBashAttack, isHitBlocked}`. It exists because SkyMP **refused** to expose the hit packet to the gamemode (issue #1338) — the event is reconstructed on the client side.
- **It is evidence, not enforcement, and that is the central decision.** Red House recalculates damage from this event and writes it into the ActorValue; that does not happen here and must not start happening. The event is sent by the player's own machine, and `CONTRIBUTING.md` §3.6 is explicit: a client event is *"a hint, not proof"*. Using it to decide damage would hand combat to whoever controls the client. The recorded row itself carries `origem: 'cliente (makeEventSource) — evidencia, nao prova'`, so nobody treats it as proof in an arbitration.
- **It aggregates into episodes, it does not record blow by blow.** An episode opens on the first hit between an `aggressor:target` pair and closes on silence (`JANELA_MS`, 10 s without a new hit); only then does the `death-service` write one row in `audit_logs` (`action='combat:episode'`) with the count, hit types and duration. A fight generates dozens of events — recording per hit would make the table useless exactly when the staff needs it most.
- **It discards self-damage** (`aggressor === target`): falls, poison and friendly fire from one's own spell are not aggression between people and are irrelevant to RDM arbitration. Ceiling of `MAX_GOLPES_POR_EPISODIO` (200) — past that point the exact number stops mattering.
- **The client snippet is deliberately kept short** and swallows its own errors: it runs inside another person's game loop, with no remote debugging, and crashing it would kill the trail of every subsequent hit by that player. Aggregation, throttling and decision stay on the server side.
- **It replaces the `checkDamageSpike`** in the `death-service` (see 1.4.3), which calls any 25-point health drop within a 2 s tick aggression — it does not tell combat from a cliff fall and does not know who struck. **The two coexist today**; the heuristic only goes away once Phase 0 confirms the event arrives.
- **Validation status**: `mp.makeEventSource` was confirmed on a real server (boot registers the event), but **the client snippet has never run** — it only executes when somebody connects. That is Phase 0 (`FASE_0_ROTEIRO.md`, step 9).

#### 1.4.6 Item validation against the plugins (`core/espm.js`)
`mp.lookupEspmRecordById(baseId)` lets the server read records from the loaded ESMs, so it can check whether a `base_id` exists and really is an item — instead of writing any number into the inventory. Discovered through the Red House study; **the return format was read from a real server, not inferred.**

- **Wired into the two points where a new `base_id` enters the system**: `/additem` and the market stall listing. In both the value is typed by hand in hexadecimal, and before this a wrong digit would write to `character_inventory` all the same — the item never appeared in game, but it occupied a row in the database and in the ledger, and nobody found out until someone checked an inventory by hand. On the stall it is worse: somebody pays for a row that never becomes an item on screen.
- **The detail a guessed implementation would get wrong**: an invalid FormID returns `{}` — an empty and **truthy** object — so `if (r)` would let the Player class pass as an item. The correct check is `r && r.record`, and there is a mutation test for it.
- **Allow list, not block list**: `TIPOS_DE_INVENTARIO` (`WEAP`, `ARMO`, `MISC`, `ALCH`, `AMMO`, `BOOK`, `INGR`, `KEYM`, `SLGM`, `SCRL`, `LIGH`). A mistyped FormID lands on any record in the game — cell, quest, sound, perk — and the right question is "is this an item?", not "is this one of the things I remembered to forbid?".
- **It lets things through when it cannot know.** If the API does not exist (old server, test environment) or failed, the return is marked `indisponivel` and `pareceItem` answers `ok`. It only denies when the API answered **and** answered that the FormID is not an item — otherwise the validation would become a way to break `/additem` rather than a diagnosis. **It is typo validation, not authority** — the same choice as 1.4.5, for the same reason.
- **Cache** by `baseId`, storing only `type` and `editorId`: the raw return carries every field of the record in bytes, and load order does not change at runtime.
- Signature documented in `types/mp.d.ts`, marked `[USO]`, with its provenance.

#### 1.4.7 Safe zones (`core/safe-zones.js`)
`core/action-policy.js` gains the ability to block **by place**, not only by character state. It originates from Red House, which checks the `isInSafeLocation` property before applying damage.

- **It answers where somebody is and what that place forbids.** `zoneOf(actorId)` reads `mp.get(actorId, 'locationalData')` and matches it against the config; `blocksCategory` answers by `action-policy` category. `canPerform` gained that dimension using the `context` that was already declared "for future validations".
- **The both-sides rule**, with its own test: an action between two people is blocked if **either one** is protected (`blocksBetween`). Protecting only the target would let someone shoot from inside the zone to outside it.
- **State is checked before place.** For someone handcuffed inside a safe zone, *"you are handcuffed"* is the useful explanation.
- **The zone list starts empty.** Config in `skymp/config/safe-zones.json`; absent or with `enabled !== true`, the module answers "there is no zone at all" and nothing changes — the same pattern as `npc-cleaner`, for the same reason: an absent config must not become surprise behaviour. **The mechanism is delivered, the policy is not**: a safe zone is world mechanics, and Constitution §15 requires the 15 questions first. The four that change the design most are in `skymp/config/safe-zones.example.json` — the main one being whether a city under truce should be a safe zone or an IC agreement the guard enforces (the second generates story, the first generates rules).
- **A broken config stays inert and shouts.** Invalid JSON does not become "everything is a safe zone" (that would switch off server combat) nor "nothing is" in silence; an unknown category inside a zone is ignored with an error in the log — a category that does not exist is a rule its author thinks they created and did not — and a zone that forbids nothing is discarded.
- **Without valid `pos`/`radius`, the zone is the whole cell.** That is coarse on purpose: "the whole tavern" is an easier decision to get right than a radius in Skyrim units, and it requires measuring nothing in game.
- **Cost**: `locationalData` is a property read served from the server cache, not a trip to Papyrus — it does not pay the 13–35 ms measured by Red House. That is why it can be consulted on every action without a special budget.
- **No current caller changed behaviour**, and there is a test for that: the place check only happens when the caller passes `context.actorId`, and none of the four existing callers does. A regression there would switch safe zones on across the whole server with nobody asking.

#### 1.4.8 Identity nametag (`nametag-service.js`) and staff reveal
Module `nametag` (`ENABLE_NAMETAG_SERVICE`), phase `lab`, **off by default**. Proof of concept for the tag above the head — the missing rung of [`technical/NAMETAG_IDENTITY_SYSTEM.md`](technical/NAMETAG_IDENTITY_SYSTEM.md).

- **World→screen projection runs on the client, not the server.** `worldPointToScreenPoint` is a native function of the game process, called by the snippet the server injects via `mp.makeProperty`/`updateOwner`. The historical blocker — "a per-frame nametag would sink the server" — came from the Red House measurements (13–35 ms per Papyrus call), which are a **network round trip** between server and client. This path doesn't pay that, so the argument that blocked the feature doesn't apply to it.
- **Two frequencies, because they are two different quantities.** Name and target every 2 s (the same tick as voice — a name only changes when someone introduces themselves); screen position up to 20 Hz on the client, because at 2 s the tag doesn't look late, it looks broken. Not per frame: the cost isn't the projection, it's `executeJavaScript` crossing into CEF — **unmeasured**, so the default is conservative.
- **One tag, the nearest one.** Ten would prove the same thing and multiply by ten a CEF cost nobody has measured.
- **It does not call `getDisplayName()` internally** — a requirement, not a convenience. When disguise becomes a rung of that function, the tag will show the disguised name without a single line of change.
- **`/revelaridentidade`** (permission `reveal_identity`, `admin` and `owner`) is an **explicit command, not passive state**: "staff always sees the real name" has no event to audit, and the display-ladder rule demands auditing. Excluded from moderator because revealing is the only staff action that **cannot be undone** — a kick ends at reconnect, gold comes back via another `/setgold`, `/permakill` is a soft delete; a revealed identity lives in the head of whoever read it. It does not write to `character_known_identities`: that is IC knowledge, and writing it would make staff call the target by their real name in chat forever.

⚠️ **The projection has never been executed.** `worldPointToScreenPoint` has never been called — that it is reachable by this path is **inference**, not observation. The axis convention was not verified, a point behind the camera is a known hole, the cost at 20 Hz was not measured, and nobody validated it with two clients. It carries the same weight that *"nobody has listened yet"* carries for native voice (1.4.4).

#### 1.4.9 Phase 0 observation instruments (`fauna-census.js`, `corpse-probe.js`)
Modules `fauna-census` (`ENABLE_FAUNA_CENSUS`) and `corpse-probe` (`ENABLE_CORPSE_PROBE`), phase `lab`, **off by default**, both behind the `run_world_probe` permission (`admin` and `owner`). They are Pieces 1 and 2 of §16 of [`technical/HOSTILE_MOB_ACTIVATION_DECISION.md`](technical/HOSTILE_MOB_ACTIVATION_DECISION.md); session protocol in [`technical/FAUNA_CENSUS_PROTOCOL.md`](technical/FAUNA_CENSUS_PROTOCOL.md).

**They are why the `module-registry` holds ten modules while this section describes eight mechanics: neither one is a mechanic.** They grant no item, change no character state, and enter no gameplay chain. They exist to answer two questions that decide whether the hunting mechanic can exist at all, and should leave the registry once they have answered them.

- **`/censofauna` is read-only, and that is the only rule it has.** It sweeps `mp.getActorsByProfileId(0)`, reads `baseDesc` and distance, aggregates by record and writes to `skymp/artifacts/`. **No `callPapyrusFunction` inside the loop** — and the argument is not the cost (though 13–35 ms × hundreds of actors would be enough): an observation instrument that calls into the engine has stopped being observation. The expensive read stays isolated in `/censofauna alvo <actorId>`, one actor at a time.
- **`/sondacadaver <actorId>` writes, which is why it has its own flag.** Four steps — read, empty, **re-read**, restore. The third separates *"`mp.set` did not throw"* from *"`mp.set` worked"*: an API that accepts the call and silently ignores the value is the likeliest case of all, and the only one an exception check would never catch. The fourth returns the world to its previous state and proves the write twice.
- **A double, independent refusal: the probe never touches a player's inventory.** `getActiveCharacterData` covers whoever has a character loaded; the `profileId` 1..50 sweep covers whoever connected and has not chosen yet. Either one alone would leave a window — and `mp.set(id,'inventory',{entries:[]})` on a player actor erases months of things that went through the `transaction-service`.

⚠️ **Neither has ever run.** `mp.get(id,'inventory')` and `mp.set(...)` are **[DOC]** (`technical/SKYMP_UPSTREAM_REFERENCE.md` §2.5) and have never been exercised by this project — **not even the return format is known**, which is why the report records it verbatim. Same weight that *"nobody has heard it yet"* carries for voice (1.4.4) and the unexecuted projection carries for the nametag (1.4.8).

### 1.5 Client launcher (`apps/launcher`)
Built with **Electron / React**. Full details in `docs/technical/LAUNCHER_DISTRIBUTION.md`.
- **Updates** to client and modpack come from **GitHub Releases** (`VITE_GITHUB_DIST_REPO`), with mandatory SHA-256 — a manifest without a hash aborts the install rather than installing unverified. It does not come from `apps/web`: the `GET /api/launcher/manifest` that lived there was a stub with a fake hash that nobody consumed, and it was removed.
- **Connection-time parity** (`verify-mods` + `analyze-plugins`) compares the hash of every file in `Data/` and validates masters/load order against `http://<SERVER_IP>:<VITE_API_PORT>/mods.json`. That endpoint is served by `apps/game-api` (see 1.3.1) — when this document said it didn't exist, that was true: the launcher called a port with no service and the step always failed as "server offline". The service came into existence on 2026-08-05. **It has not been exercised against a packaged launcher**, only by automated tests.
- **Login**: the launcher only captures Discord's `code`; the token exchange is done by the web panel (`POST /api/launcher/oauth/exchange`), because any secret embedded in an app distributed to players can be extracted from the installer.
- Configuration comes from `VITE_*` variables inlined at **build time** by `vite.config.ts`'s `define` — there is no `.env` on the packaged app's side.

## 2. Decision flow (the golden rule)

On our server, authority is never delegated to the client.

**Example flow (fishing or smithing):**
1. The player (client) presses a button to interact.
2. The gamemode (server) receives the request, checks in the database whether they have the rod/resource and the required skill.
3. The server changes the database, saves the new item.
4. The server fires `mp.callPapyrusFunction` only so the client plays the animation and gets the visual success notice.
*(If a local mod tries to skip step 2, it fails silently, protecting the economy.)*

The technical detail of this rule — what a mod can and cannot touch, why mod Papyrus scripts produce no state, and the FormID contract that forces load order parity — is in [`MODS_AND_GAMEMODE_CONTRACT.en.md`](technical/MODS_AND_GAMEMODE_CONTRACT.en.md).
