# usage-snapshot-001 — Hub usage snapshot

## Outcome

Publish producer-neutral usage snapshot v1 files for pi-agent-hub's quota header and Usage view. The canonical consumer contract belongs to companion ticket `usage-001` in `masta-g3/pi-agent-hub`. This repository has no Hub code dependency or plugin loader.

- `usage/pi-accounts-limits.json`: safe account labels, plans, quota windows, reset credits, freshness, and actionable quota errors. Failed refreshes retain the previous windows and successful reading time; removing the last account publishes an empty list.
- `usage/pi-accounts-history.json`: daily provider/model totals, seven-day hourly totals, and daily project totals with distinct session counts; recorded cost, API-equivalent estimates, and cache savings.
- Only TUI sessions publish, and only when the Hub state directory already exists. Resolve it through `PI_AGENT_HUB_DIR`, otherwise `<Pi agent dir>/pi-agent-hub`. Headless sessions and users without Hub receive no new files or cache.
- Snapshots and the aggregate cache omit account emails, credentials, and conversation content. History deliberately includes provider/model IDs, project paths, and the scanned session root.

## Implementation decisions

- Reused `UsageMonitor` and existing discovery/session events. Limits publish after a one-second debounce. History checks ten seconds after startup, every five minutes, and sixty seconds after `agent_end`; timers are unref'd and cleared at shutdown.
- Added `src/snapshot.ts` for contract mapping, Hub-dir gating, and private temporary-file/atomic-rename writes. Added `src/history.ts` for indexing, prices, rollups, and coordination. README documents behavior, paths, privacy, and module ownership. No dependencies were added.
- The scanned root comes from `sessionManager.getSessionDir()`: use the parent for Pi's standard per-project layout under `<agentDir>/sessions`, otherwise scan the explicit custom directory. Cache keys are canonical absolute paths; pruning stays within the scanned root.
- Cache and coordination files live under `<Pi agent dir>/pi-accounts/`. Unchanged files retain buckets; appended files verify head/tail checkpoints and read only complete new lines. Rewritten/truncated files rebuild, removed files are pruned, and files changed during a read retry next cycle.
- Compact per-file tuples retain all daily history and seven days of hourly buckets. Time-zone or pricing changes invalidate cache generations; entries outside the active root rebuild when their own root is scanned instead of being pruned.
- Fork headers identify copied history: skip usage older than the fork header's timestamp. Parse only headers and lines containing `"usage"`; ignore malformed/non-assistant records, invalid timestamp shapes/ranges, and entries without numeric usage.
- Pricing uses `modelRegistry.getAll()` and pi-ai `calculateCost`, including tiers and one-hour cache writes. Positive recorded cost wins. Otherwise match the same model ID with nonzero rates, preferring its provider, then Anthropic, OpenAI, and provider-ID order. Unpriced messages count tokens; estimates remain null when every contributing message is unpriced.
- Day buckets use the producer's local IANA time zone; hours use UTC epoch starts. Snapshots enforce 50,000 daily, 10,000 hourly, and 20,000 project rows plus a 16 MiB serialized cap by dropping oldest days. Cache writes enforce 32 MiB.
- Cross-session indexing uses a PID/token lock and a five-minute completion marker keyed by root, time zone, and pricing hash. Complete lock metadata is written to an exclusive private temporary file before an exclusive hard link publishes the lock. Recover only dead PIDs, never old live locks. A short-lived recovery lock serializes stale-owner recovery; release checks ownership tokens.

## Validation

Evidence: [`agent-work/tickets/usage-snapshot-001/validation.md`](../tickets/usage-snapshot-001/validation.md).

| Real-corpus check | Result |
| --- | --- |
| Files | 22,077 |
| Usage messages | 242,169 |
| Total tokens | 16,010,493,007; exact independent Python match |
| Recorded cost | 12244.71837791; exact match at contract-number precision |
| Fork entries excluded | 5,090; every id/timestamp matches its parent file |
| Other duplicate keys | 0 |
| First / incremental wall time | 14.372 s / 0.634 s |
| First / incremental maximum event-loop lag | 60.553 ms / 52.702 ms; both below 150 ms |
| Cache / snapshot size | 12,131,087 / 396,420 bytes |
| Daily / hourly / project rows | 550 / 266 / 1,182 |

- Independent arbitrary-precision Decimal sums differ by −6.894363e−14 dollars because bucketed JSON numbers use floating-point addition; there is no missing usage or cent-level difference.
- Hub's reader accepted every produced history row unchanged and merged one source. Compatibility validation used temporary reader copies; no companion-checkout files were changed.
- Real-corpus runs read session logs only and wrote only under `/tmp/accounts-usage-validation.WOJlVC`. The snapshot remains there for parent-coordinated Hub captures. No real Hub/cache path was used. Privacy scans found no email patterns, credential/content keys, or JWT patterns.
- Main-thread measurements passed the responsiveness budget; a worker thread was unnecessary.
- Final verification: `npm run check`, **84 tests**, and `git diff --check` passed. Tests cover publishing/gating/freshness, incremental reconciliation, malformed input, fork exclusion, lock contention/recovery/publication, coalescing, root boundaries, time zones, pricing, and caps.

## Review and reflection

- Review fixed malformed-record/timestamp failures that could abort a scan and the empty-public-lock crash window. Both have deterministic regression tests.
- Code-critic job `5ec161c7-f5e0-48f0-b88e-86f206e05313`: one finding accepted, none rejected; second pass LGTM with no remaining high-impact issues.
- Reflection found no additional durable guidance or follow-up tickets needed. README already owns user instructions; code issues were fixed and tested in the owning layer. CI already runs type checking and tests. Docs-critic was skipped because reflection changed no guidance.
- No discovered work or unresolved reflection candidates remain. The validation document is retained as useful review evidence; temporary outputs are not committed.

## Commit and merge boundary

- Worktree: `/Users/manager/.local/share/agent-worktrees/usage-snapshot-001-8b3849946c78/pi-accounts`; branch `usage-snapshot-001`; PR target `main`.
- Rules record: `/Users/manager/.local/share/agent-worktrees/usage-snapshot-001-8b3849946c78/worktree.json`.
- This branch starts from local `main`, including the not-yet-pushed commit `533c813` ("Mark the lone Codex account active while chat uses openai login"). That commit is included in this PR.
- User approved commit, push to origin, and a draft PR. Retain the worktree and branch in `awaiting-merge`; merge and cleanup require the user's later confirmation.
