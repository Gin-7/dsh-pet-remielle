# dsh-pet-remielle · Remielle Desktop Pet

[![npm version](https://img.shields.io/npm/v/dsh-pet-remielle)](https://www.npmjs.com/package/dsh-pet-remielle)
[![awesome dsh plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A multi-pet web desktop pet **driven by real DSH session events** — it tracks DeepSeek Harness task progress in real time and presents it with sticker animations + status bubbles.

- Multi-pet registry + status bubbles (project / phase / tasks / progress in real time)
- SSE live push + optional desktop floating window (bundled Electron, transparent & always-on-top)
- Double-click drawing: brush-reveal artwork (drawing → satisfied → fade-out)
- Built-in version check + one-click incremental update
- Settings panel: pet management (tabbed) + plugin config card

> Compatible with DeepSeek Harness (and its forks) web profile; desktop mode is off by default and can be enabled anytime.

---

## Features

| Capability | Details |
|---|---|
| State source | DSH `session/event` real events — no DOM scraping |
| State machine | Pure-function `PetReducer` with mood mapping (unit-tested) |
| Message protocol | Typed protocol (protocol.js) |
| Configuration | schemastery persistence + settings card |
| Multi-session priority | Unread completions > waiting/errors > current session > state priority > recency |
| Live push | SSE stream (auto-reconnect + polling fallback) |
| Status bubble | Adaptive two-layer deck on both the in-page pet and the desktop window: top status card + `+N` summary backboard; message + detail (project · completed x/y · phase) |
| Session actions | Web: card / `?` / `!` open the session, `✓` allows once; desktop: no navigation, `✓` still allows once |
| Completion reminders | Persist until handled: web returns to idle after opening that session; desktop click dismisses the green dot and idles immediately. The current session has no unread dot (current Host lifetime only) |
| Balance | Single-click the pet to show DeepSeek balance + time period (60s auto-refresh, rolling-number animation, stale fallback on network blips), auto-returns to the status bubble after 5s |
| Today usage | Two modes: ledger (default, token-free, balance-delta) / real-time token (platform usage API + peak/off-peak pricing, exact) |
| Desktop float | Bundled Electron transparent always-on-top window (opt-in) |
| Multi-pet | Settings → Pet Management (registry + switch active pet) |
| Version update | Built-in check + one-click incremental update |

---

## Sticker (mood) → State Mapping

| Sticker | Preview | Trigger |
|---|---|---|
| 01 Drawing | <img src="assets/pets/remielle/01.gif" width="56" alt="01 Drawing"/> | THINKING + streaming: streaming output / double-click drawing |
| 02 Slacking | <img src="assets/pets/remielle/02.gif" width="56" alt="02 Slacking"/> | WORKING / ERROR: tool calls (search/edit/test/command) |
| 03 Pleased | <img src="assets/pets/remielle/03.gif" width="56" alt="03 Pleased"/> | PULSE SUCCESS: turn completed / drawing finished / click interaction |
| 04 Thinking | <img src="assets/pets/remielle/04.gif" width="56" alt="04 Thinking"/> | THINKING: turn/step start, reasoning, result compilation |
| 05 Waiting | <img src="assets/pets/remielle/05.gif" width="56" alt="05 Waiting"/> | WAITING: question answer, approval pending, turn blocked |
| 06 Idle | <img src="assets/pets/remielle/06.gif" width="56" alt="06 Idle"/> | IDLE / DISCONNECTED: idle, after turn ends |

When multiple sessions run concurrently, the top task is selected by `unread completion > waiting/error > current session > state priority > recency`; every other session is represented by a clickable `+N` summary backboard. Sub-agents are ignored by default (configurable).

### Pet Definition Convention

```
assets/pets/<id>/01.gif  Drawing (output)
assets/pets/<id>/02.gif  Slacking (tools/errors)
assets/pets/<id>/03.gif  Pleased (completed/interaction)
assets/pets/<id>/04.gif  Thinking
assets/pets/<id>/05.gif  Waiting
assets/pets/<id>/06.gif  Idle
```

Optional extensions (don't affect completeness validation):
```
assets/pets/<id>/07.gif           Extra sticker slot
assets/pets/<id>/pet-manifest.json  Per-sticker alignment offsets + artwork count
assets/pets/<id>/pics/<n>.png      Artwork images (double-click to pop, n starts at 1)
```

`id` may contain only letters, numbers, underscores, and hyphens. Built-in pet: **Remielle** (see `NOTICE` for asset copyright).

---

## Installation

For **DSH / DeepSeek Harness** (including Fairy and other DSH-based forks) web profile.

```powershell
# Option 1: npm registry (recommended, one-click incremental update)
dsh plugin --profile web add dsh-pet-remielle

# Option 2: GitHub repository (build install, no version check)
dsh plugin --profile web add github:Gin-7/dsh-pet-remielle

# Option 3: Local directory (dev/debug, link install)
dsh plugin --profile web add D:\path\to\dsh-pet-remielle

# Option 4: GitHub Release tgz
dsh plugin --profile web add "C:\Users\you\Downloads\dsh-pet-remielle-<version>.tgz"
```

Plugin row id: `dsh-pet-remielle`. Uninstalling removes everything cleanly.

---

## Updating

Built-in update check in Settings → Pet Management → Update + bottom-right update bubble: checks GitHub for the latest version and offers one-click update.

| Install type | Version | Update method |
|---|---|---|
| Local link | ≥ 0.3.0 | One-click `git pull` (incremental) |
| npm registry | ≥ 0.3.0 | One-click `pnpm update dsh-pet-remielle` (incremental) |
| Any type | < 0.3.0 | **No auto-update**: package/row-id changed since 0.3.0 — must fully uninstall then reinstall |

> **Why?** Before 0.3.0 there were package/row-id renames (before 0.2.0 it was `@dsh-external/dsh-client-ui-pet-remielle`, from 0.2.0–0.3.0 it was `dsh-pet-remielle`). `git pull`/`pnpm update` can't cross that boundary, so versions below 0.3.0 must be uninstalled first (otherwise you get `loaded without registering … via __ModuleLoader__.load` errors):

```powershell
# Uninstall by the actual old row id (whichever applies):
dsh plugin --profile web remove @dsh-external/dsh-client-ui-pet-remielle   # < 0.2.0
dsh plugin --profile web remove dsh-pet-remielle                            # 0.2.0 – 0.3.0

# Reinstall latest:
dsh plugin --profile web add dsh-pet-remielle
# or: dsh plugin --profile web add github:Gin-7/dsh-pet-remielle
```

> The same uninstall/reinstall guidance is shown in Settings → Pet Management → Update when the installed version is below 0.3.0.

---

## Desktop Floating Mode (opt-in)

`desktopMode` is off by default. When enabled, a **transparent, always-on-top, frameless** Electron window displays the pet.

- Window supports dragging (position remembered), scroll-wheel zoom, double-click drawing, right-click menu.
- Status/balance bubbles match the web pet: stacked session cards and a single toggle dot. Desktop card clicks do not navigate; a completed-card click only clears the reminder and returns to idle. `✓` still clicks Allow once. The in-page pet still opens the conversation.
- Double-click drawing: artwork appears in a **desktop top-right** independent window, brush-reveal along the diagonal, then "Pleased → fade-out".
- Right-click menu: switch to web mode, lock, bubble toggle, size, drawing, etc.
- Closing/switching returns to the in-page pet automatically; window closes when DSH host exits.

**Electron runtime sources (probed in order):** `DSH_PET_ELECTRON` env var → `vendor/electron-win32-x64/` (not in Git) → system-installed Electron → none → in-page only.

> **First run**: if desktop mode is enabled but no Electron runtime is found locally, a **prompt will offer to download and install it** (requires confirmation, ~200 MB). Download failure falls back to in-page display automatically. You can also manually extract an Electron win32-x64 release to `vendor/electron-win32-x64/` or set `DSH_PET_ELECTRON` to an existing `electron.exe`.

### Platform support

| Platform | Desktop float | In-page pet |
|---|---|---|
| Windows x64 (Fairy desktop / pure DSH) | ✓ (Electron transparent window) | Hidden when desktop mode is on |
| macOS / Linux | ✗ | ✓ (falls back to in-page automatically) |

---

## Usage

- **Single-click pet**: cycle through random sticker moods, and show the balance + time-period bubble (DeepSeek balance / today usage / off-peak or peak period); auto-returns to the status bubble after 5s.
- **Double-click pet**: enter drawing animation; after completion a artwork pops up (screen top-right) and fades out.
- **Right-click pet (in-page)**: character size / lock position / show bubble / usage mode / desktop float mode / reset position / pause animation.
- **Right-click pet (desktop window)**: character size / lock position / show bubble / usage mode / drawing / switch to web mode.
- **Scroll wheel**: resize character.
- In-page pet menu can also launch the desktop window.

---

## Balance & Today Usage

Single-click the pet to see your DeepSeek account balance and today's spend (bubble shows "DeepSeek Balance ¥X" + "Today ¥X · Off-peak/Peak", the period is color-coded: green = off-peak, red = peak).

- **Balance**: from the official API `api.deepseek.com/user/balance` (credential `DEEPSEEK_API_KEY`). Auto-refreshes every 60s; single-click the pet to refresh manually; rolling-number animation on changes; transient network blips keep the last known balance instead of flashing errors.
- **Today usage · ledger (default, token-free)**: accumulates balance deltas into `$DSH_HOME/.dshp-usage.json` (cross-day reset & archive). No extra token needed, but it is an estimate — usage while DSH is off is not recorded.
- **Today usage · real-time token (exact)**: after configuring the platform session token `DEEPSEEK_PLATFORM_TOKEN`, it queries the platform cost API (`platform.deepseek.com/api/v0/usage/by_api_key/cost`) and reads the platform's own per-hour CNY amount — no local pricing table, so DeepSeek price changes are followed automatically:
  - The bubble also shows the current period (off-peak / peak; peak: 09:00–12:00 and 14:00–18:00 Beijing time)
  - Falls back to ledger mode when the token is missing or invalid

**Switching usage mode**: Settings → Pet Management → Behavior → "Usage Mode" (ledger / real-time token), or the pet's right-click menu → "Usage Mode".

> To obtain `DEEPSEEK_PLATFORM_TOKEN`: sign in to platform.deepseek.com → F12 DevTools → Network → open the "Usage" page → copy the `Authorization` header value of the `api/v0/usage/...` request → add it to the DSH credentials service.

---

## Configuration (Settings → Plugin → Remielle Desktop Pet)

| Field | Default | Description |
|---|---|---|
| enabled | true | Enable the pet (disables immediately, re-enabling restores) |

All other appearance/behavior options (size, opacity, lock, bubble, usage mode, desktop float, pause, hide, etc.) are managed in Settings → Pet Management and the right-click menu, not duplicated in the plugin config card.

## Settings → Pet Management

Pet registry section with tabbed sub-pages: **Appearance / Behavior / Desktop Float / Update / Feedback**.

- Enable/disable pets, set as current, rename, add new pets.
- Behavior page: enable / lock / pause / hide / respond to sub-agents / show bubble / **usage mode**.
- "Update": shows current version, check for updates, one-click update, upgrade guide.
- "Feedback": shows pet version, submit bug reports / feature requests.

---

## Development

```powershell
npm install
node scripts/build-client.mjs    # Build lib/client.js (version injected from package.json)
npm test                          # node --test unit tests
npm run check                     # Syntax check
```

### Directory Structure

```
src/
├── index.js          # Host: config, event wiring, config/state/balance/pets/assets/desktop endpoints, self-update routes
├── balance.js        # Balance service: fetch (retry/cache/stale fallback), today usage (ledger/token), peak pricing
├── self-update.js    # Version check + one-click update (GitHub direct + HTTP proxy fallback; git pull / pnpm update)
├── pet-reducer.js    # Pure state machine: session events → state/pulse/task (unit-tested)
├── protocol.js       # Typed protocol: PetState / PetMood / PetMessageKind
├── pets.js           # Pet registry: directory discovery/merge/validation (unit-tested)
├── status-copy.js    # Remielle-flavored status copy (replaceable)
├── desktop-window.js # Desktop mode: Electron discovery + window process management (unit-tested)
├── pet-window.js     # Desktop mode: Electron main (transparent window + top-right artwork window)
├── pet-view.html     # Desktop mode: pet window page (GIF + bubble + SSE + drawing + balance bubble)
├── balance-widget.js # Balance controller (client): fetch/rolling animation/5s auto-return, rendered into the pet's own bubble
└── client.core.js    # Browser side: pet UI + settings (wrapped at build time)
lib/client.js         # Build artifact (version injected, ready to use)
assets/pets/remielle/ # Remielle assets (GIFs + artwork)
scripts/build-client.mjs
test/                 # node --test
```

### Publishing to npm

```powershell
npm login
pnpm version patch    # Bump version
pnpm pack --dry-run   # Check what will be published (no node_modules / vendor)
pnpm publish
```

> Published content is controlled by the `files` field: `src/`, `lib/client.js`, `assets/`, `scripts/`, `test/`, `cordis.patch.yml`, `NOTICE`, `README.md`. The `vendor/` (Electron runtime) is not published — desktop mode downloads it on demand.

---

## License & Asset Copyright

Source code is distributed under MIT License; the Remielle character art and GIF/ artwork assets are copyrighted by miHooyoverse (HoYoverse),
**commercial use and redistribution of assets is prohibited**. See `NOTICE` for details.
