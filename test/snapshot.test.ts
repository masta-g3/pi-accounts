import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { limitsSnapshot, hubDirectory, ledgerQuota, publishLimits, readLedger } from "../src/snapshot.ts";

test("limits map safe labels, plans, freshness, resets and errors without identity", () => {
  const value = limitsSnapshot([{ kind: "codex", slot: 2, provider: "openai-codex-account-2", label: "secret@example.com", accountId: "token-secret" }], () => ({
    checkedAt: 100, fetchedAt: 90, error: true, errorMessage: "Sign in again with /login.",
    usage: { tier: "pro", resets: 2, windows: [{ label: "5h", remaining: 82, reset: 200 }, { label: "week", remaining: 61, reset: 300 }] },
  }), 110);
  assert.deepEqual(value, { version: 1, producer: "pi-accounts", updatedAt: 110, accounts: [{ id: "openai-codex-account-2", key: value.accounts[0].key, provider: "Codex", label: "Codex 2", plan: "pro", checkedAt: 100, fetchedAt: 90, error: "Sign in again with /login.", resetCredits: 2, windows: [
    { id: "5h", label: "5h", remainingPercent: 82, resetAt: 200, durationMs: 18000000 },
    { id: "week", label: "week", remainingPercent: 61, resetAt: 300, durationMs: 604800000 },
  ] }] });
  assert.match(value.accounts[0].key, /^[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(value), /secret|@|accountId/);
  assert.deepEqual(limitsSnapshot([{ kind: "claude", slot: 1, provider: "claude-bridge", label: "private" }], () => undefined, 1).accounts, [{ id: "claude-bridge", key: limitsSnapshot([{ kind: "claude", slot: 1, provider: "claude-bridge", label: "private" }], () => undefined, 1).accounts[0].key, provider: "Claude", label: "Claude 1", windows: [] }]);
});

test("publishing requires an existing Hub dir and uses complete atomic files", async t => {
  const dir = await mkdtemp(join(tmpdir(), "accounts-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(hubDirectory(dir, {}), join(dir, "pi-agent-hub"));
  assert.equal(hubDirectory(dir, { PI_AGENT_HUB_DIR: join(dir, "custom") }), join(dir, "custom"));
  const hub = join(dir, "hub");
  assert.equal(await publishLimits(hub, [], () => undefined, 1), false);
  assert.deepEqual(await readdir(dir), []);
  await mkdir(hub);
  await publishLimits(hub, [], () => undefined, 2);
  assert.deepEqual(JSON.parse(await readFile(join(hub, "usage/pi-accounts-limits.json"), "utf8")), { version: 1, producer: "pi-accounts", updatedAt: 2, accounts: [] });
  await Promise.all(Array.from({ length: 20 }, (_, i) => publishLimits(hub, [], () => undefined, i)));
  assert.deepEqual(await readdir(join(hub, "usage")), ["pi-accounts-limits.json"]);
  assert.ok(JSON.parse(await readFile(join(hub, "usage/pi-accounts-limits.json"), "utf8")).version === 1);
});

test("publishing merges the shared ledger by newest reading per account", async t => {
  const hub = await mkdtemp(join(tmpdir(), "accounts-ledger-"));
  t.after(() => rm(hub, { recursive: true, force: true }));
  const codex = { kind: "codex" as const, slot: 1, provider: "openai-codex", label: "a@example.com", accountId: "acct-a" };
  const claude = { kind: "claude" as const, slot: 1, provider: "claude-bridge", label: "b@example.com" };
  const fresh = (remaining: number, at: number) => ({ usage: { tier: "max", windows: [{ label: "week" as const, remaining, reset: 9e12 }] }, fetchedAt: at, checkedAt: at });
  await publishLimits(hub, [codex, claude], account => account === codex ? fresh(68, 500) : fresh(100, 900), 1000);
  // An older session's stale reading and its failure from before the newer success must not regress the ledger.
  await publishLimits(hub, [codex, claude], account => account === codex
    ? fresh(70, 400)
    : { ...fresh(5, 100), checkedAt: 850, error: true, errorMessage: "Quota unavailable (HTTP 429)." }, 1100);
  let ledger = await readLedger(hub);
  assert.equal(ledgerQuota(ledger, codex)?.usage?.windows[0].remaining, 68);
  assert.deepEqual(ledgerQuota(ledger, claude), { usage: { tier: "max", windows: [{ label: "week", remaining: 100, reset: 9e12 }] }, fetchedAt: 900, checkedAt: 900 });
  await publishLimits(hub, [claude], () => ({ ...fresh(100, 900), checkedAt: 1200, error: true, errorMessage: "Quota unavailable (HTTP 429)." }), 1200);
  ledger = await readLedger(hub);
  assert.equal(ledgerQuota(ledger, codex), undefined, "the writer's account list defines the ledger");
  assert.equal(ledgerQuota(ledger, claude)?.errorMessage, "Quota unavailable (HTTP 429).", "a failure after the newest success is the latest state");
  assert.equal(ledgerQuota(ledger, claude)?.usage?.windows[0].remaining, 100);
  assert.equal(ledgerQuota(ledger, { ...claude, label: "other@example.com" }), undefined, "a replaced login cannot reuse the entry");
  assert.doesNotMatch(await readFile(join(hub, "usage/pi-accounts-limits.json"), "utf8"), /example|acct-a/);
  assert.deepEqual(await readLedger(join(hub, "missing")), new Map());
});
