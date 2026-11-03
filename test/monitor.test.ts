import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageMonitor } from "../src/monitor.ts";
import { REFRESH_MS, type QuotaSnapshot } from "../src/status.ts";
import type { Account, Usage } from "../src/accounts.ts";

const account: Account = { kind: "codex", slot: 1, provider: "openai-codex", label: "Personal", accountId: "a" };
const usage = (now: number): Usage => ({ windows: [{ label: "5h", remaining: 80, reset: now + 3600000 }] });

test("shares in-flight requests and refreshes only when due or explicitly requested", async () => {
  let now = 1000;
  let calls = 0;
  let finish!: (value: Usage) => void;
  const monitor = new UsageMonitor(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, () => {}, () => now);
  const first = monitor.load(account);
  const second = monitor.load(account, true);
  assert.equal(calls, 1);
  assert.equal(monitor.snapshot(account), undefined, "an in-flight request records no attempt yet");
  finish(usage(now));
  assert.deepEqual(await first, await second);
  await monitor.load(account);
  assert.equal(calls, 1);
  now += REFRESH_MS;
  const next = monitor.load(account);
  assert.equal(calls, 2);
  assert.equal(monitor.snapshot(account)?.checkedAt, 1000);
  finish(usage(now));
  await next;
  monitor.stop();
});

test("failed refresh retains marked-stale data without retrying on every repaint", async () => {
  let now = 1000;
  let calls = 0;
  const monitor = new UsageMonitor(async () => { if (++calls > 1) throw new Error("offline"); return usage(now); }, () => {}, () => now);
  await monitor.load(account);
  now += REFRESH_MS;
  await assert.rejects(monitor.load(account), /offline/);
  assert.equal(monitor.snapshot(account)?.usage?.windows[0].remaining, 80);
  assert.equal(monitor.snapshot(account)?.error, true);
  await assert.rejects(monitor.load(account), /offline/);
  assert.equal(calls, 2);
  monitor.stop();
});

test("reset windows refresh early and an account replacement cannot reuse a snapshot", async () => {
  let now = 1000;
  let calls = 0;
  const monitor = new UsageMonitor(async () => { calls++; return { windows: [{ label: "5h", remaining: 0, reset: now + 60000 }] }; }, () => {}, () => now);
  await monitor.load(account);
  now += 60000;
  await monitor.load(account);
  assert.equal(calls, 2);
  const replacement = { ...account, accountId: "b" };
  assert.equal(monitor.snapshot(replacement), undefined);
  await monitor.load(replacement);
  assert.equal(calls, 3);
  assert.equal(monitor.snapshot(account), undefined);
  monitor.stop();
});

test("shutdown aborts work and late results cannot repaint or populate state", async () => {
  let signal!: AbortSignal;
  let finish!: (value: Usage) => void;
  let changes = 0;
  const monitor = new UsageMonitor((_account, passedSignal) => { signal = passedSignal; return new Promise(resolve => { finish = resolve; }); }, () => { changes++; });
  const pending = monitor.load(account);
  monitor.stop();
  assert.ok(signal.aborted);
  finish(usage(Date.now()));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(changes, 0);
  assert.equal(monitor.snapshot(account), undefined);
});

test("a fresh shared ledger reading replaces the request, keeping its own timestamps", async () => {
  let now = 10 * REFRESH_MS;
  let calls = 0;
  let shared: QuotaSnapshot | undefined = { usage: usage(now), fetchedAt: now - 60000, checkedAt: now - 60000 };
  const monitor = new UsageMonitor(async () => { calls++; return usage(now); }, () => {}, () => now, async () => shared);
  assert.equal((await monitor.load(account)).windows[0].remaining, 80);
  assert.equal(calls, 0);
  assert.deepEqual(monitor.snapshot(account), shared);
  now += REFRESH_MS - 60000;
  await monitor.load(account);
  assert.equal(calls, 1, "a reading older than the refresh interval is fetched again");
  assert.equal(monitor.snapshot(account)?.fetchedAt, now);
  now += 61000;
  shared = { usage: usage(now), fetchedAt: now - 120000, checkedAt: now - 120000 };
  await monitor.load(account, true);
  assert.equal(calls, 2, "forced refreshes reuse only readings from the last minute");
  shared = { usage: usage(now), fetchedAt: now - 30000, checkedAt: now - 30000 };
  await monitor.load(account, true);
  assert.equal(calls, 2);
  assert.equal(monitor.snapshot(account)?.fetchedAt, now, "an older shared reading never replaces a newer local one");
  monitor.stop();
});

test("a recent shared failure is adopted instead of retrying, and expired windows need a later check", async () => {
  let now = 10 * REFRESH_MS;
  let calls = 0;
  let shared: QuotaSnapshot | undefined = { usage: usage(now), fetchedAt: now - 3600000, checkedAt: now - 1000, error: true, errorMessage: "Quota unavailable (HTTP 429)." };
  const monitor = new UsageMonitor(async () => { calls++; return usage(now); }, () => {}, () => now, async () => shared);
  await assert.rejects(monitor.load(account), /HTTP 429/);
  assert.equal(calls, 0);
  assert.equal(monitor.snapshot(account)?.checkedAt, now - 1000);
  assert.equal(monitor.snapshot(account)?.error, true);
  const other: Account = { ...account, provider: "openai-codex-account-2" };
  shared = { usage: { windows: [{ label: "5h", remaining: 5, reset: now - 5000 }] }, fetchedAt: now - 9000, checkedAt: now - 9000 };
  await monitor.load(other);
  assert.equal(calls, 1, "a reading taken before its window reset is not reused");
  monitor.stop();
});
