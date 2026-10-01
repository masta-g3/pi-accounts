# Pi Codex accounts

[![CI](https://github.com/masta-g3/pi-codex-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/masta-g3/pi-codex-accounts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

See remaining Codex quota in Pi's footer. Use `/codex` to switch accounts, add an account, or choose a default for new sessions.

```text
Codex · 5h / week  ●1 ▰▰▰▰▱ ▰▰▰▱▱  │  2 ⏳42m ▰▰▰▰▰
```

Switching is manual. There is no automatic routing or failover.

## Install

```sh
pi install git:github.com/masta-g3/pi-codex-accounts
```

Run `/reload` in existing Pi sessions, or start a new session.

Tested against Pi **0.87.1**. Requires Node **22.19 or later**. Pi loads the TypeScript source directly; there is no build step. This package is distributed through GitHub, not npm.

## Use

Run `/codex` to open the picker:

```text
Codex accounts
Manual switching · current model stays unchanged

→ ● personal@example.com · 1       default · week 82% left
  ○ secondary@example.com · 2      week 64% left
  + Add account                    Sign in through Pi

↑↓ · Enter use · d default · Esc close
```

| Action | Result |
| --- | --- |
| **Enter** on an account | Switch this session's account without changing its model. |
| **d** on an account | Save that account and the current Codex model as Pi's global defaults for new sessions. Do not switch this session. |
| **Add account** | Prepare Pi's `/login` command. Submit it, choose the intended account in the browser, then reopen `/codex`. |
| **Esc** | Close without changing accounts. |

`●` marks the active account. The `default` badge marks the saved global default; they can be different. Explicit CLI choices, project overrides, and resumed sessions keep Pi's usual precedence.

The first account uses existing `openai-codex` credentials. Added accounts use `openai-codex-account-2`, `openai-codex-account-3`, and so on. Pi handles login, token refresh, credential storage, and `/logout`. Account labels use the token's email when available, otherwise `Account N`.

Choose a Codex model with `/model` before switching or saving a default. If model scope excludes an account, enable its model in `/scoped-models` before switching this session.

## Read the bars

Each five-cell bar shows **remaining**, not used, quota. It is approximate; `/codex` shows exact percentages.

- With two limits, the first bar is five-hour quota and the second is weekly quota.
- With only a weekly limit, the footer shows `Codex · week  ●1 ▰▰▰▰▰`.
- Accounts with different limits get a label beside each bar.
- Bars turn amber at 25% or less. Exhausted limits show a red reset countdown.
- Narrow panes keep the active account and show `+N` for hidden accounts when space allows.

| Indicator | Meaning |
| --- | --- |
| `·····` | Loading |
| `?????` | Unknown, or a reset needs a fresh reading |
| `~` beside an account | Stale reading; its bars are dimmed |

Quota refreshes on session start and every **five minutes** while a Codex model is selected in the terminal UI. Reset windows are rechecked within 30 seconds. Opening `/codex` requests fresh readings and shares any request already in progress.

Requests have an eight-second deadline and never block switching. Closing the picker stops its UI updates; shared footer requests continue until completion, shutdown, or reload. Quota stays in memory. Concurrent Pi sessions refresh independently.

## Limits and privacy

- The picker is TUI-only. Headless sessions can use a saved default or an explicit account provider, but do not poll quota.
- Account aliases remain visible in Pi's model selector. Extensions that match provider IDs, such as `pi-openai-fast`, need the added IDs in their own configuration.
- Child-session account inheritance has not been verified. There is no custom Hub or subagent integration.
- Do not combine this package with an automatic Codex account router. Other extensions' account aliases are not imported.
- Quota comes from ChatGPT's backend usage endpoint, not a guaranteed public API. Missing quota does not prevent switching.
- Emails appear in the picker and switch notifications, not the footer. The extension reads Pi's credentials and sends the account token only to ChatGPT's usage endpoint. Pi may refresh its own OAuth credentials.
- The extension writes no credentials or quota files. Pressing **d** writes defaults through Pi's settings API.

When reporting a bug, include the Pi version, Node version, and steps to reproduce. Do not attach `auth.json`, tokens, or unredacted account screenshots.

## Development

```sh
git clone https://github.com/masta-g3/pi-codex-accounts.git
cd pi-codex-accounts
npm ci
npm run check
npm test
```

For local use, run `pi install .` from the checkout, then `/reload`.

```text
src/
  index.ts      Command, session events, and refresh timer
  accounts.ts   Account discovery, quota parsing, and scope checks
  provider.ts   Delegate to Pi's Codex transport with account ownership
  quota.ts      Usage requests and cancellation
  monitor.ts    In-memory snapshots and shared requests
  status.ts     Footer bars and responsive layout
  picker.ts     Native Pi selection UI
test/           Tests for these modules
```

Tests use isolated settings and synthetic credentials. They cover switching, defaults, scope, cancellation, quota rendering, freshness, and native tool-call conversion without inference calls. Live second-account OAuth and a real model response still need manual verification.

## Credits and license

Design reference: HenryQW's [pi-multi-codex](https://github.com/HenryQW/pi-harness/tree/main/extensions/pi-multi-codex). This package takes a narrower, manual-only approach.

[MIT](LICENSE).
