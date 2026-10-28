# Pi accounts

[![CI](https://github.com/masta-g3/pi-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/masta-g3/pi-accounts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

See remaining Codex and Claude Code quota in Pi's footer. Use `/accounts` to switch accounts or choose a default for new sessions.

```text
Codex ●1 ▰▰▰▰▱ 3h ▰▰▰▱▱ 5d · 2 ▰▰▰▰▰ 2h ▰▰▰▰▱ 6d  │  Claude 1 ▰▰▰▰▰ 4h ▰▰▰▰▱ 6d
```

Switching is manual. There is no automatic routing or failover.

## Install

```sh
pi install git:github.com/masta-g3/pi-accounts
```

Install [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) separately to use Claude. Run `/reload` in an existing Pi session, or start a new session. Tested against Pi 1.3.0. Requires Node 22.19 or later.

## Use

Run `/accounts`:

```text
Accounts
Codex ↔ Codex keeps the model · Claude uses its last model

→ ● personal@example.com · Codex 1    default · week 82% left
  ○ me@example.com · Claude 1         5h 98% left · week 89% left
  + Add Codex account                 Sign in through Pi

pro
5h 98% left · resets 20:20 (in 4h 47m)
week 89% left · resets Sat 06:00 (in 5d 14h)
↑↓ · Enter use · d default · l sign out · Esc close
```

- **Enter** switches to the selected account. Codex-to-Codex keeps the model ID.
- A cross-provider switch uses the last model used on that provider in the current session branch. If there is no valid model in history, choose one from a second list.
- **d** saves the account and resolved model as Pi's global default. It does not switch the current session.
- **l** starts sign-out guidance for the selected account. For Codex, it prepares Pi's `/logout` command and tells you which account to choose. For Claude, it tells you to run `claude auth logout` in a terminal. It never replaces a nonempty editor draft.
- **Add Codex account** prepares Pi's `/login` command. The extension does not add Claude logins.
- Model scope applies to session switching. Enable excluded models in `/scoped-models`.

The first Codex account uses `openai-codex`. Added accounts use `openai-codex-account-2` and later IDs. Claude uses the single `claude-bridge` provider and the login managed by Claude Code. Multiple Claude logins are not supported because the bridge uses one process-wide `CLAUDE_CONFIG_DIR`.

## Read the bars

Each five-cell bar shows remaining quota, followed by the time until that limit resets: `▰▰▰▰▱ 3h`. Accounts with a 5-hour and a weekly limit show two bars, 5-hour first. Accounts with one limit show one bar. Select an account in `/accounts` to see the exact local reset time.

- `●` marks the active account. Inactive accounts are dimmed. No account is marked when another provider is active.
- Bars turn amber at 25% or less. Exhausted limits show a red reset countdown.
- `↻2` after a Codex account means it has 2 rate-limit resets available. It is hidden when there are none.
- `·····` means loading. `?????` means a window needs a fresh reading. `~` marks stale data.
- `⚠` replaces the bars when an account has no quota reading, for example after its login expired. Open `/accounts` to see the reason.
- Narrow panes keep the active account, or the first account when neither is active, and show `+N` when space allows.

Quota refreshes every five minutes while the TUI is open. Reset windows are checked within 30 seconds. Claude quota is force-refreshed within 60 seconds after a Claude response. Requests have an eight-second deadline and do not block switching.

## Limits and privacy

- Quota endpoints are undocumented. A quota failure does not prevent account switching.
- Codex tokens are resolved through Pi and sent only to ChatGPT's usage endpoint.
- Claude credentials are read from the macOS keychain or `<CLAUDE_CONFIG_DIR>/.credentials.json`. The access token is sent only to `https://api.anthropic.com/api/oauth/usage`.
- This extension never refreshes or writes Claude credentials. Run Claude Code when its login expires.
- Account emails appear in the picker and notifications, not in the footer.
- The picker is TUI-only. Headless sessions do not poll quota.
- Pressing **d** writes Pi defaults. The extension writes no credentials or quota files.
- Codex account aliases appear in Pi's model selector. Extensions that match provider IDs, such as `pi-openai-fast`, need the added IDs in their own configuration.
- Do not combine this package with an automatic Codex account router.
- Pressing **l** does not edit credentials directly. Codex sign-out uses Pi's native `/logout`; Claude sign-out stays in the Claude CLI.

Do not attach credentials, tokens, or unredacted account screenshots to bug reports.

## Development

```sh
git clone https://github.com/masta-g3/pi-accounts.git
cd pi-accounts
npm ci
npm run check
npm test
```

```text
src/
  index.ts      Command, session events, discovery, and refresh timers
  accounts.ts   Account data, quota parsing, history, and scope checks
  claude.ts     Claude Code credential and identity discovery
  provider.ts   Codex account provider delegation
  quota.ts      Codex and Claude usage requests and cancellation
  monitor.ts    In-memory snapshots and shared requests
  status.ts     Grouped footer bars and responsive layout
  picker.ts     Account and model selection UI
test/           Isolated tests with synthetic credentials and responses
```

## Credits and license

Design reference: HenryQW's [pi-multi-codex](https://github.com/HenryQW/pi-harness/tree/main/extensions/pi-multi-codex). Switching in this package remains manual.

[MIT](LICENSE).
