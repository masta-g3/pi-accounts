**Feature:** auto-resume-001 → Auto resume
**Session:** 01a1dba4-439b-7214-87e6-84388ddf2929
**Worktree:** /Users/manager/.local/share/agent-worktrees/auto-resume-001-bdaeac7b9392/pi-accounts
**Branch:** auto-resume-001
**Start branch / PR target:** main / main
**Worktree record:** /Users/manager/.local/share/agent-worktrees/auto-resume-001-bdaeac7b9392/worktree.json

## Delivered

- Optional global auto-resume, off by default. Press `a` in `/accounts` to toggle it; state lives in `<Pi agent dir>/pi-accounts/config.json`.
- An error settlement checks the failed account's quota. Exhausted 5-hour or weekly windows schedule one visible message 60–120 seconds after the latest reset: `Continue where you left off. The usage limit has reset.`
- A notice and footer marker show the pending resume time. Main sessions, orchestrators and tmux subagents use the same extension behavior. Non-TUI sessions do not auto-resume; Hub is unchanged.
- User input, model/account changes, shutdown or toggle-off cancel the wait. Timers are in memory only: restart or `/reload` drops them. Busy sessions and changed logins never receive the automatic message.
- No automatic account/model switching or spending reset credits. Three consecutive failed automatic resumes stop further attempts until successful settlement or user input.

## Implementation and review decisions

- Reused `UsageMonitor`, atomic JSON publishing, picker actions, footer rendering, and existing date/duration formatting. No new library or Hub contract.
- Extended quota loads with `notBefore`: stale cached readings cannot hide exhaustion. Older pending requests finish before a fresh request starts.
- Captured account and cancellation generation at run start. Cancellation cannot recreate eligibility at settlement or redirect an old failure to a newly selected account.
- User approved requiring Pi 1.5.2 during review to use `agent_settled.aborted`. Updated the Pi development dependencies, runtime peer floor and README. Aborted runs never arm a resume, including aborts after a boundary handler ran.
- Fixed an existing flaky Claude-refresh test by waiting for its asynchronous ledger read. Provider conversion tests use an available catalog model rather than a removed fixed ID.
- Code-critic approved after three passes; all four actionable correctness findings were fixed.

## Verification

- `npm run check`: passed.
- `npm test`: 103/103 passed after final review fixes.
- `git diff --check`: passed.
- Isolated real TUI smoke test with synthetic quota/429 responses verified the notice, footer marker, timed visible continue, re-arming and global toggle-off cancellation. Temporary files/session removed; live credentials and installed code were unchanged.

## Boundaries and follow-up

- No restart persistence, account routing, Hub waiting-state display or headless auto-resume.
- Optional future work: show pending resume times on Hub cards or persist waits across restarts. Neither is required for this feature.
- No new reflection candidates from review. README usage, privacy/state paths and picker examples were updated during execution.
- Retain the worktree pending approved integration. Its ignored `node_modules/` is disposable at later user-approved cleanup; no temporary ticket artifacts were added.
