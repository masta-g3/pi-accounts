import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { limitsSnapshot, hubDirectory, publishLimits } from "../src/snapshot.ts";

test("limits map safe labels, plans, freshness, resets and errors without identity", () => {
  const value = limitsSnapshot([{ kind: "codex", slot: 2, provider: "openai-codex-account-2", label: "secret@example.com", accountId: "token-secret" }], () => ({
    checkedAt: 100, fetchedAt: 90, error: true, errorMessage: "Sign in again with /login.",
    usage: { tier: "pro", resets: 2, windows: [{ label: "5h", remaining: 82, reset: 200 }, { label: "week", remaining: 61, reset: 300 }] },
  }), 110);
  assert.deepEqual(value, { version: 1, producer: "pi-accounts", updatedAt: 110, accounts: [{ id: "openai-codex-account-2", provider: "Codex", label: "Codex 2", plan: "pro", checkedAt: 100, fetchedAt: 90, error: "Sign in again with /login.", resetCredits: 2, windows: [
    { id: "5h", label: "5h", remainingPercent: 82, resetAt: 200, durationMs: 18000000 },
    { id: "week", label: "week", remainingPercent: 61, resetAt: 300, durationMs: 604800000 },
  ] }] });
  assert.doesNotMatch(JSON.stringify(value), /secret|@|accountId/);
  assert.deepEqual(limitsSnapshot([{ kind: "claude", slot: 1, provider: "claude-bridge", label: "private" }], () => undefined, 1).accounts, [{ id: "claude-bridge", provider: "Claude", label: "Claude 1", windows: [] }]);
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
