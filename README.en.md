# SkyMP Heavy RP — a roleplay server for Skyrim multiplayer

*[Português](README.md) · **English** · [Русский](README.ru.md) · [Español](README.es.md)*

An open, current **RP server base for Skyrim Special Edition multiplayer**, built on [SkyMP](https://github.com/skyrim-multiplayer/skymp). Node.js gamemode, whitelist panel, Electron launcher and modpack parity verification.

Built for *strict roleplay*: server authority over economy, identity and consequence, without compromising network sync.

> **Why this exists:** as of August 2026, the SkyMP community has no open, maintained RP server base. The only public one — [Red House](https://github.com/alekcey0211/red-house-public) — has been unmaintained since 2021 and is Russian-only. This project aims to fill that gap.

> ⚠️ **Not production-ready.** The gameplay code is verified only by unit tests against a mocked `mp` API — **nothing has been validated in a real game session yet**. See the [QA report](docs/technical/QA_REPORT_2026-08.md) for an honest component-by-component status.

---

## New here?

| You want to | Start with |
|---|---|
| Understand what the project **means to be** | [CONSTITUICAO.md](docs/CONSTITUICAO.md) — the design constitution (Portuguese) |
| Understand the real project status | [QA Report](docs/technical/QA_REPORT_2026-08.md) — includes what is **not** ready |
| See what the framework does today, post-08/22 unification | [PROJECT_STATE.md](PROJECT_STATE.md) — Identity + Economy + Professions + Depot + Persistence + UX (Portuguese) |
| Understand how the pieces talk | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Contribute code | [CONTRIBUTING.en.md](CONTRIBUTING.en.md) — the rules that aren't obvious from reading the code |
| Know if a mod works on the server | [Mods × Gamemode Contract](docs/technical/MODS_AND_GAMEMODE_CONTRACT.md) §4 |
| Set up the server from scratch (database, `.env`, Skyrim assets, Discord, tunnel) | [FASE_0_SETUP_DO_ZERO.en.md](docs/technical/FASE_0_SETUP_DO_ZERO.en.md) — full checklist + known issues |
| Browse all documentation | [docs/README.md](docs/README.md) |
| Report a security issue | [SECURITY.en.md](SECURITY.en.md) — **do not open a public issue** |
| Ask, propose, or show what you built | [Discussions](https://github.com/vinicius3232/skymp-heavy-rp/discussions) |

**Language note:** entry-point documents (this README, contributing and security guides) are maintained in Portuguese, English, Russian and Spanish. The remaining technical documentation is **Portuguese only** — see [Documentation language](#documentation-language) below.


### Quick Tips for Newcomers
- Start with the [QA Report](docs/technical/QA_REPORT_2026-08.md) to know what is actually working.
- Read [CONTRIBUTING.en.md](CONTRIBUTING.en.md) before opening any pull request.
- Most deep technical docs are in Portuguese — use a translator if needed, or ask in Discussions.
- This project is still in laboratory stage — do not expect a playable public server yet.
---


## What's in the box

| Component | What it does |
|---|---|
| `skymp/gamemode` | Node.js gamemode: RP chat, governance (arrest, fines, taxes), player market stalls, death with consequence, in-game panel, proximity voice |
| `skymp/ui` | In-game CEF interface |
| `apps/web` | Staff panel, whitelist, Discord OAuth, and the **SkyMP master API** that makes player identity server-authoritative |
| `apps/game-api` | Port 7758: modpack parity (`/mods.json`) and entry queue |
| `apps/bot-discord` | Role sync and temporary voice channels |
| `apps/launcher` | Electron + React launcher: client/modpack updates, integrity checks, queue |
| `skymp/packages/database` | MariaDB schema and migrations |

### Things you won't find elsewhere

- **A typed `mp` API** ([`types/mp.d.ts`](skymp/gamemode/types/mp.d.ts)) — SkyMP publishes no typings.
- **A map of the real SkyMP API** ([`SKYMP_UPSTREAM_REFERENCE.md`](docs/technical/SKYMP_UPSTREAM_REFERENCE.md)), including hooks the official docs never mention, sourced from upstream's own integration tests.
- **Working session master API** — most test servers run in `offlineMode`, where the client declares its own identity and the server believes it.
- **Atomic economy** with a ledger ([`core/transaction-service.js`](skymp/gamemode/core/transaction-service.js)).
- **Modpack parity** with a manifest generator.

---

## Running it

This is the quick summary. **Full step-by-step guide, with a known-issues section:** [FASE_0_SETUP_DO_ZERO.en.md](docs/technical/FASE_0_SETUP_DO_ZERO.en.md) — covers the database, every `.env` file, Skyrim assets, the SkyMP server artifact, Discord, and going public through a tunnel/domain. Worth reading before a from-scratch setup: every step in it exists because someone got stuck there first.

Requires **Node.js 20+**, **MariaDB/MySQL**, and **Skyrim SE/AE** for in-game testing.

```bash
git clone https://github.com/vinicius3232/skymp-heavy-rp.git
cd skymp-heavy-rp

# Each service has its own dependencies
cd skymp/gamemode   && npm ci && cd ../..
cd apps/web         && npm ci && cd ../..
cd apps/game-api    && npm ci && cd ../..
cd apps/bot-discord && npm ci && cd ../..
```

Copy every `.env.example` to `.env` and fill it in — the comments explain where each value comes from. Apply `schema.sql`, then every `migration-v*.sql` file in `skymp/packages/database/`, in numeric order (there are more than `v9` by now — check the folder for the current highest number).

```powershell
.\scripts\phase0\Start-AllServices.ps1
```

The script checks `.env` and `node_modules` for each service first and tells you what won't start, instead of reporting success with a dead service.

### Debugging tools you probably don't know about

- **`localhost:9000`** in your normal browser opens **DevTools for the game's embedded browser** — console, inspector and breakpoints for the in-game UI. Without it you're debugging blind.
- The server **proxies UI requests to a dev server on port 1234**, so you can iterate on interface CSS/JS without restarting anything.

---

## Documentation language

Entry points are bilingual. **Deep technical documentation stays in Portuguese**, deliberately.

That's a maintenance decision, not an oversight. Roughly 26 technical documents change often, and a stale translation is worse than no translation — it's a document people trust that quietly lies. Keeping one authoritative version means it stays correct.

If a specific document blocks you, open an issue and we'll translate that one. Machine translation handles these files reasonably well since they're plain Markdown.

---

## Related projects

If you're searching for a Skyrim multiplayer RP server, you'll run into these. Here's where each one stands:

| Project | What it is | Status |
|---|---|---|
| [skyrim-multiplayer/skymp](https://github.com/skyrim-multiplayer/skymp) | The platform. C++ server, Skyrim Platform and TypeScript SDK. **This project runs on top of it.** | Active |
| [alekcey0211/red-house-public](https://github.com/alekcey0211/red-house-public) | Public RP server build, GPL-3.0. The only one that existed. Studied in detail [here](docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md). | Unmaintained since 2021, Russian-only |
| [alekcey0211/skymp5-scripts](https://github.com/alekcey0211/skymp5-scripts) | Papyrus scripts for RP, same author as Red House. | Unmaintained since 2021 |
| [skyrim-roleplay](https://github.com/skyrim-roleplay) (Keizaal Online) | An RP server's organization. The SkyMP fork is public; the gamemode isn't. | Active, RP code closed |
| [Silveira-Software/SKYRIMRP-BR](https://github.com/Silveira-Software/SKYRIMRP-BR) | Brazilian RP server, PT-BR. The repo is announcements only — the code is closed. | Active, closed source |

**The gap this project tries to fill:** active servers keep their gamemode closed, and the only open one has been dormant for years. Anyone wanting to build an RP server today has nothing to start from.

---

## License

Free software under **[GNU AGPL-3.0-or-later](LICENSE)**.

Deliberate choice: the goal is a public, current RP server base for the community. AGPL costs us nothing we weren't already giving away, and it protects the goal — anyone who modifies this base and runs a server **must offer their modifications to players** (AGPL §13). It's also the same license as `skymp5-server`, which everything here runs on.

If you run a modified version, the source link must point to **your** version. See [PUBLIC_BUILD_GUIDE.md](docs/technical/PUBLIC_BUILD_GUIDE.md) §3.

**The license covers our code — not third-party mods, not Bethesda assets.** Nothing from Bethesda is redistributed here; you need to own Skyrim.

> This is an independent community project. Not affiliated with, endorsed, or sponsored by Bethesda Softworks, ZeniMax Media, Microsoft, or any official rights holder of The Elder Scrolls/Skyrim. All trademarks belong to their respective owners.
