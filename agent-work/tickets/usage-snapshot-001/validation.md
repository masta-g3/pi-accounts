# Usage snapshot validation

Validated on 2026-11-02 in the `usage-snapshot-001` worktree. Node v26.7.0. No new dependencies.

## Safety and reproduction

- Read source logs only from `/Users/manager/.pi/agent/sessions`.
- All real-corpus writes went to `/tmp/accounts-usage-validation.WOJlVC`: a temporary agent directory, cache, model catalog, Hub directory, and validation scripts. No real Hub state or real cache was used. No credentials were loaded: `ModelRuntime.create` used temporary paths and `refreshOnCreate: false` for its built-in price catalog.
- Run `node /tmp/accounts-usage-validation.WOJlVC/spike.mjs`, then `python3 /tmp/accounts-usage-validation.WOJlVC/verify.py` to repeat the measured index cycles and independent totals check. To repeat a first run, use a new temporary agent/cache directory, not a real cache path.
- The temporary directory remains available for review and the companion Hub's end-to-end validation. The obsolete first-spike directory was removed. No snapshot was copied into the Hub worktree.

## Final real-corpus measurements

The measurement script sampled event-loop delay every 50 ms and waited for two additional samples after indexing. Each cycle used `force: true` to measure actual indexing rather than the five-minute coalescing shortcut.

| Check | First index | Incremental index | Budget |
| --- | ---: | ---: | ---: |
| Wall time | 14.372 s | 0.634 s | Incremental: a few seconds |
| Maximum event-loop delay | 60.553 ms | 52.702 ms | < 150 ms |
| Files discovered | 22,077 | 22,077 | All scanned files |
| Files parsed | 22,077 | 2 | Only changed files on rerun |
| Cache bytes | 12,131,087 | 12,131,087 | ≤ 33,554,432 |
| Snapshot bytes | 396,421 | 396,420 | ≤ 16,777,216 |

The main-thread implementation passes the responsiveness budget. A worker thread is not needed. Compact per-file aggregate tuples and seven-day hourly retention keep the cache bounded.

Final history rows: **550 daily**, **266 hourly**, **1,182 project** rows.

## Independent Python comparison

The Python checker separately parsed the same session files up to each captured complete-line offset from the cache. It applied the fork cutoff from the session header. It did not reuse cached usage buckets. Head/tail SHA-256 checkpoints matched for every captured prefix; no file changed between this index and verification.

| Metric | Independent logs | Published daily rollup |
| --- | ---: | ---: |
| Assistant usage messages | 242,169 | 242,169 |
| Input tokens | 1,006,646,482 | 1,006,646,482 |
| Output tokens | 95,509,815 | 95,509,815 |
| Cache-read tokens | 14,731,339,229 | 14,731,339,229 |
| Cache-write tokens | 176,997,481 | 176,997,481 |
| Total tokens | 16,010,493,007 | 16,010,493,007 |
| Recorded cost (contract number precision) | 12244.71837791 | 12244.71837791 |

All token and message totals match exactly. Recorded cost also matches exactly as an IEEE-754 contract number: converting the independent Decimal sum to a number equals Python's `math.fsum` over published daily costs. For transparency, arbitrary-precision Decimal representations differ by `−6.894363e−14` dollars because JSON number buckets use floating-point addition; there is no missing usage or cent-level difference.

The fork rule skipped **5,090** copied entries. Every skipped entry had an exact `(id, message.timestamp)` match in its `parentSession` file. There were **0** missing parent matches and **0** other duplicate keys across the corpus.

## Hub reader compatibility

A temporary copy of the companion Hub's current `src/core/usage.ts`, `atomic-json.ts`, and `terminal-text.ts` parsed the produced snapshot. Only its relative `.js` import suffixes were changed to `.ts` for direct Node execution; the parser itself was unchanged. The companion checkout was read-only.

- `parseUsageSnapshot` accepted the history section.
- All **550 / 266 / 1,182** rows survived validation unchanged (`deepEqual` on daily, hourly, and project rows).
- `readUsageDir` merged exactly **1** history source.

The snapshot remains at `/tmp/accounts-usage-validation.WOJlVC/hub/usage/pi-accounts-history.json` for the parent to coordinate Hub UI captures.

## Privacy and automated checks

A grep-equivalent scan of both the real cache and history snapshot found **0** email patterns, **0** credential/content keys, and **0** JWT patterns. Synthetic limits and extension tests assert that account emails, account identities, and access-token sentinels do not appear in quota output. The cache contains only paths, fingerprints, offsets, and usage aggregates.

Execute verification: `npm run check` passed; `npm test`: **82 passed, 0 failed**; `git diff --check` passed. Review verification after the corrections below: **84 passed, 0 failed**, with type checking and diff checking also passing.

Review added regressions for malformed record shapes and invalid timestamp types/ranges, plus deterministic lock publication. The first test failed on a null JSONL header before the fix; a separate reproduction showed a numeric timestamp of `1e20` also aborted indexing. The lock regression pauses exclusive file creation and asserts that no public lock exists yet; it failed before metadata publication changed to an exclusive hard link. Both regressions pass after the owning-layer corrections. The real-corpus totals and snapshot above are unaffected.

Tests cover quota mapping and retained-error freshness; empty account removal and headless gating; startup/agent-end debounce and shutdown cleanup; append offsets, rewrites, truncation, deletion, partial lines, malformed/non-assistant entries, concurrent writes; fork exclusion; live/dead locks and concurrent stale recovery; cross-run coalescing; root-limited pruning and lazy cross-root invalidation; DST/midnight/fractional zones; recorded/estimated/unpriced costs, tiered rates and one-hour cache writes; hourly retention; and snapshot row/byte caps.
