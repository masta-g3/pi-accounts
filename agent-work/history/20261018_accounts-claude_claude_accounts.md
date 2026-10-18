# Codex and Claude accounts

**Feature:** accounts-claude → Codex and Claude Code quota and switching
**Completed:** 2026-10-18
**Checkout:** main, no worktree

## Outcome

- Renamed the package to `pi-accounts` and replaced `/codex` with `/accounts`. Folder and GitHub repository remain `pi-codex-accounts`.
- Added the single Claude Code login used by `pi-claude-bridge` alongside existing Codex accounts. Credentials are read from macOS keychain or Claude's credential file, never written or refreshed. Claude quota requests use only Anthropic's usage endpoint.
- Reused the existing monitor, bar rendering, and native Codex provider delegation. Quota polls while the TUI is open regardless of active provider; Claude responses trigger a throttled/coalesced refresh within 60 seconds.
- Cross-provider switching restores the last valid model from the current session branch, otherwise opens a model list. Codex-to-Codex switching retains the model. Defaults can be saved without switching. Idle state, identity, availability and scope are checked before acting.
- Footer shows each remaining-quota bar followed by time until reset, with no window-name prefixes or shared legend. Inactive accounts are dimmed. Unavailable accounts show one `⚠`; expired windows remain unknown; stale readings stay marked. Narrow layouts retain the active account (or first account) and hidden count when space allows.
- Picker details show local reset times and remaining durations. `l` prepares native `/logout` guidance for the selected Codex account without replacing drafts; Claude sign-out points to `claude auth logout`. The extension does not directly remove credentials.

## Validation

- TypeScript check and all 63 tests passed. Regression coverage includes credential parsing, quota requests, grouped responsive layout, colors, delayed refresh, discovery lifecycle, account/model picker actions, switching races, scope, defaults and sign-out guidance.
- Isolated Pi 1.3.0 TUI checks verified provider switching, footer, default saving, sign-out command preparation and reset details. Real user defaults were not changed; no real logout was submitted.
- Final artifact and diff whitespace scans passed. No new dependencies.

## Deferred / reflection

- Multiple Claude logins require per-account support in `pi-claude-bridge`; excluded from this change. No follow-up ticket created.
- Reported overlap beside Claude's weekly bar was not reproducible from text. A screenshot after reload is needed if it persists.
- README updated for current UI, privacy, tested version and provider-alias/router constraints. No new agent guidance needed.
