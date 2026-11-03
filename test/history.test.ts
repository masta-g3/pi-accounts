import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { acquireLock, releaseLock, indexHistory, sessionRoot, buildHistory, type HistoryOptions } from "../src/history.ts";

const now = Date.parse("2026-11-02T12:00:00Z");
const header = (extra = {}) => JSON.stringify({ type: "session", id: "s", cwd: "/project", timestamp: "2026-11-01T00:00:00Z", ...extra }) + "\n";
const message = (extra: any = {}, envelope: any = {}) => JSON.stringify({ type: "message", id: "m", message: { role: "assistant", provider: "claude-bridge", model: "test", timestamp: now - 3600000, content: "NEVER STORE secret@example.com", usage: { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost: { total: 0 } }, ...extra }, ...envelope }) + "\n";
const model: any = { id: "test", provider: "anthropic", api: "anthropic-messages", cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12 } };
async function fixture(t: any) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "accounts-history-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "sessions"); const hubDir = join(dir, "hub");
  await mkdir(root); await mkdir(hubDir);
  const options: HistoryOptions = { root, hubDir, agentDir: dir, models: [model], now, timeZone: "UTC", force: true };
  const file = join(root, "one.jsonl");
  await writeFile(file, header() + message());
  const history = async () => JSON.parse(await readFile(join(hubDir, "usage/pi-accounts-history.json"), "utf8")).history;
  return { dir, root, file, options, history };
}

test("indexes only assistant usage, skips malformed lines and waits for complete trailing lines", async t => {
  const f = await fixture(t);
  await appendFile(f.file, 'bad "usage"\n' + message({ role: "user" }) + message({ usage: undefined }) + message().trimEnd());
  await indexHistory(f.options);
  let h = await f.history();
  assert.equal(h.daily[0].messages, 1); assert.equal(h.daily[0].input, 10);
  assert.ok(Math.abs(h.daily[0].estimatedCost - 0.000196) < 1e-12); assert.ok(Math.abs(h.daily[0].cacheSavings - 0.00018) < 1e-12);
  const cache = await readFile(join(f.dir, "pi-accounts/usage-index.json"), "utf8");
  assert.doesNotMatch(cache, /NEVER|secret@|content/);
  const reads: number[] = [];
  await appendFile(f.file, "\n");
  await indexHistory({ ...f.options, onRead: (_path, offset) => reads.push(offset) });
  assert.ok(reads[0] > 0); h = await f.history(); assert.equal(h.daily[0].messages, 2);
  assert.equal((await indexHistory(f.options)).readFiles, 0);
});

test("malformed record shapes and out-of-range timestamps do not abort indexing", async t => {
  const f = await fixture(t);
  await writeFile(f.file, "null\n" + message({ timestamp: 1e20 }) + message({ timestamp: { toString: 1 } }) + message());
  await indexHistory(f.options);
  const h = await f.history();
  assert.equal(h.daily.length, 1);
  assert.equal(h.daily[0].messages, 1);
  assert.equal(h.daily[0].input, 10);
});

test("rewrites, truncation and deletion replace buckets, while pruning stays within the root", async t => {
  const f = await fixture(t); await indexHistory(f.options);
  const original = header() + message();
  await writeFile(f.file, original.replace('"input":10', '"input":50'));
  await indexHistory(f.options); assert.equal((await f.history()).daily[0].input, 50);
  await writeFile(f.file, header() + message({ model: "changed-longer" }) + message());
  await indexHistory(f.options); assert.equal((await f.history()).daily.reduce((s: number, r: any) => s + r.messages, 0), 2);
  await writeFile(f.file, header()); await indexHistory(f.options); assert.deepEqual((await f.history()).daily, []);
  const other = join(f.dir, "other"); await mkdir(other); await writeFile(join(other, "two.jsonl"), original);
  await indexHistory({ ...f.options, root: other });
  await rm(f.file); await indexHistory(f.options);
  const cache = JSON.parse(await readFile(join(f.dir, "pi-accounts/usage-index.json"), "utf8"));
  assert.equal(Object.keys(cache.files).length, 1); assert.ok(cache.files[join(other, "two.jsonl")]);
});

test("forks skip copied history and projects count distinct files", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "fork.jsonl"), header({ parentSession: f.file, timestamp: "2026-11-02T10:30:00Z" }) + message({ timestamp: now - 7200000 }) + message());
  await indexHistory(f.options);
  const h = await f.history(); assert.equal(h.daily[0].messages, 2); assert.equal(h.projects[0].sessions, 2); assert.equal(h.projects[0].tokens, 70);
});

test("lock metadata is complete before the exclusive lock becomes visible", async t => {
  const f = await fixture(t); const path = join(f.dir, "lock");
  const fs = (await import("node:fs/promises")).default;
  const originalOpen = fs.open;
  let opened!: () => void, resume!: () => void;
  const openedPromise = new Promise<void>(resolve => { opened = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args);
    if (String(args[0]).startsWith(path) && args[1] === "wx") { opened(); await paused; }
    return file;
  });
  syncBuiltinESMExports();
  const acquiring = acquireLock(path);
  try {
    await openedPromise;
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally {
    resume(); await acquiring;
    mock.mock.restore(); syncBuiltinESMExports();
  }
  const token = await acquiring;
  const lock = JSON.parse(await readFile(path, "utf8"));
  assert.equal(lock.pid, process.pid); assert.equal(lock.token, token);
  await releaseLock(path, token!);
});

test("locks never steal a live pid, recover dead pids and token-check release", async t => {
  const f = await fixture(t); const path = join(f.dir, "lock");
  const first = await acquireLock(path); assert.ok(first);
  assert.equal(await acquireLock(path), undefined);
  await releaseLock(path, "wrong"); assert.equal(await acquireLock(path), undefined);
  await releaseLock(path, first!);
  await writeFile(path, JSON.stringify({ pid: 2147483647, token: "old", startedAt: 1 }));
  const next = await acquireLock(path); assert.ok(next);
  await releaseLock(path, "old"); assert.equal(await acquireLock(path), undefined);
  await releaseLock(path, next!);
  await writeFile(path, JSON.stringify({ pid: process.pid, token: "ancient", startedAt: 1 }));
  assert.equal(await acquireLock(path), undefined);
});

test("coalesces across runs and does no work without a Hub dir", async t => {
  const f = await fixture(t);
  assert.equal((await indexHistory({ ...f.options, force: false })).status, "completed");
  assert.equal((await indexHistory({ ...f.options, force: false })).status, "coalesced");
  assert.equal((await indexHistory({ ...f.options, hubDir: join(f.dir, "missing") })).status, "disabled");
  assert.equal(sessionRoot(join(f.dir, "sessions/--cwd--"), f.dir), f.root);
  assert.equal(sessionRoot(join(f.dir, "custom"), f.dir), join(f.dir, "custom"));
});


test("daily time zones handle DST, midnight and fractional offsets; changed zone rebuilds", async t => {
  const f = await fixture(t);
  await writeFile(f.file, header() + ["2026-11-01T03:30:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"].map(timestamp => message({ timestamp })).join(""));
  await indexHistory({ ...f.options, timeZone: "America/New_York" });
  let h = await f.history();
  assert.deepEqual(h.daily.map((r: any) => [r.day, r.messages]), [["2026-10-31", 1], ["2026-11-01", 2]]);
  assert.equal(h.hourly.length, 3);
  await writeFile(f.file, header() + ["2026-11-01T18:14:59Z", "2026-11-01T18:15:00Z"].map(timestamp => message({ timestamp })).join(""));
  await indexHistory({ ...f.options, timeZone: "Asia/Kathmandu" });
  h = await f.history(); assert.deepEqual(h.daily.map((r: any) => r.day), ["2026-11-01", "2026-11-02"]);
  const reads: number[] = [];
  await indexHistory({ ...f.options, timeZone: "UTC", onRead: (_p, offset) => reads.push(offset) });
  assert.deepEqual(reads, [0]); assert.equal((await f.history()).daily.length, 1);
});

test("pricing prefers recorded costs, uses provider preference, counts unpriced tokens, and invalidates prices", async t => {
  const f = await fixture(t);
  await writeFile(f.file, header() + message() + message({ usage: { input: 10, cost: { total: 2 } } }) + message({ model: "unknown" }));
  await indexHistory(f.options);
  let h = await f.history();
  const known = h.daily.find((r: any) => r.model === "test"), unknown = h.daily.find((r: any) => r.model === "unknown");
  assert.equal(known.cost, 2); assert.ok(Math.abs(known.estimatedCost - 2.000196) < 1e-12);
  assert.equal(unknown.estimatedCost, null); assert.equal(unknown.cacheSavings, null); assert.equal(unknown.input, 10);
  const reads: number[] = [];
  const own = { ...model, provider: "claude-bridge", cost: { ...model.cost, input: 100 } };
  await indexHistory({ ...f.options, models: [model, own], onRead: (_p, offset) => reads.push(offset) });
  assert.deepEqual(reads, [0]);
  h = await f.history(); assert.ok(h.daily.find((r: any) => r.model === "test").estimatedCost > known.estimatedCost);
});

test("hourly includes only the last seven days; concurrent writes defer a file until next cycle", async t => {
  const f = await fixture(t);
  await writeFile(f.file, header() + message({ timestamp: now - 8 * 86400000 }) + message());
  await indexHistory(f.options); let h = await f.history(); assert.equal(h.hourly.length, 1); assert.equal(h.daily.length, 2);
  await appendFile(f.file, message());
  const fs = await import("node:fs");
  await indexHistory({ ...f.options, onRead: () => fs.appendFileSync(f.file, message()) });
  h = await f.history(); assert.equal(h.daily.reduce((s: number, r: any) => s + r.messages, 0), 2);
  await indexHistory(f.options); assert.equal((await f.history()).daily.reduce((s: number, r: any) => s + r.messages, 0), 4);
});

test("snapshot row and byte caps discard entire oldest days", async () => {
  const { capSnapshot } = await import("../src/history.ts");
  const row = { provider: "p", model: "m", messages: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, estimatedCost: null, cacheSavings: null };
  const snapshot = { version: 1, producer: "pi-accounts", updatedAt: now, history: { generatedAt: now, source: "pi-sessions:/tmp", timeZone: "UTC", firstDay: "2026-01-01", providers: [], daily: Array.from({ length: 50001 }, (_, i) => ({ ...row, day: i < 50000 ? "2026-01-01" : "2026-01-02" })), hourly: [], projects: [] } };
  capSnapshot(snapshot); assert.deepEqual(snapshot.history.daily.map(r => r.day), ["2026-01-02"]);
  snapshot.history.daily.unshift({ ...row, day: "2026-01-01", model: "x".repeat(10000) });
  capSnapshot(snapshot, 1500); assert.equal(snapshot.history.daily.length, 1); assert.equal(snapshot.history.firstDay, "2026-01-02");
});


test("dead-owner recovery has exactly one winner under contention", async t => {
  const f = await fixture(t); const path = join(f.dir, "lock");
  await writeFile(path, JSON.stringify({ pid: 2147483647, token: "dead", startedAt: 1 }));
  const results = await Promise.all(Array.from({ length: 12 }, () => acquireLock(path)));
  assert.equal(results.filter(Boolean).length, 1);
  await releaseLock(path, results.find(Boolean)!);
  await mkdir(join(f.dir, "pi-accounts"));
  const lockPath = join(f.dir, "pi-accounts/usage-index.lock");
  const token = await acquireLock(lockPath);
  assert.equal((await indexHistory(f.options)).status, "locked");
  await releaseLock(lockPath, token!);
});

test("pricing changes invalidate other roots lazily without pruning their entries", async t => {
  const f = await fixture(t); await indexHistory(f.options);
  const other = join(f.dir, "other"); await mkdir(other); await writeFile(join(other, "two.jsonl"), header() + message());
  await indexHistory({ ...f.options, root: other, timeZone: "Asia/Kathmandu" });
  let cache = JSON.parse(await readFile(join(f.dir, "pi-accounts/usage-index.json"), "utf8"));
  assert.equal(Object.keys(cache.files).length, 2);
  const reads: number[] = [];
  await indexHistory({ ...f.options, timeZone: "Asia/Kathmandu", onRead: (_p, offset) => reads.push(offset) });
  assert.deepEqual(reads, [0]);
  cache = JSON.parse(await readFile(join(f.dir, "pi-accounts/usage-index.json"), "utf8"));
  assert.equal(Object.keys(cache.files).length, 2);
});

test("pi-ai tiered prices and one-hour cache writes apply to API estimates", async t => {
  const f = await fixture(t);
  const tiered = { ...model, cost: { ...model.cost, tiers: [{ inputTokensAbove: 25, input: 20, output: 40, cacheRead: 2, cacheWrite: 24 }] } };
  await writeFile(f.file, header() + message({ usage: { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cacheWrite1h: 2, cost: { total: 0 } } }));
  await indexHistory({ ...f.options, models: [tiered] });
  const row = (await f.history()).daily[0];
  assert.ok(Math.abs(row.estimatedCost - (0.0002 + 0.00008 + 0.00004 + 0.000104)) < 1e-12);
  assert.ok(Math.abs(row.cacheSavings - 0.00036) < 1e-12);
});
