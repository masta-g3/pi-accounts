import { createReadStream } from "node:fs";
import { link, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, basename, join, resolve, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { atomicJson, hubExists } from "./snapshot.ts";

type Metrics = [number, number, number, number, number, number, number | null, number | null];
// Compact tuples keep the per-file cache bounded. They contain aggregates, never messages.
type Bucket = [string | number, string, string, ...Metrics];
type FileIndex = { generation: number; size: number; mtime: number; offset: number; head: string; tail: string; cwd: string; fork?: number; daily: Bucket[]; hourly: Bucket[] };
type Cache = { version: number; generation: number; timeZone: string; pricingHash: string; files: Record<string, FileIndex> };
export type HistoryOptions = { root: string; agentDir: string; hubDir: string; models: Model<any>[]; now?: number; timeZone?: string; force?: boolean; onRead?: (path: string, offset: number) => void };
export type IndexResult = { status: "completed" | "disabled" | "locked" | "coalesced"; readFiles: number; files?: number; cacheBytes?: number; snapshotBytes?: number };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const within = (path: string, root: string) => { const rel = relative(root, path); return !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel); };
export function sessionRoot(sessionDir: string, agentDir: string): string {
  const dir = resolve(sessionDir);
  return dirname(dir) === resolve(agentDir, "sessions") && /^--.*--$/.test(basename(dir)) ? dirname(dir) : dir;
}
async function optionalJson(path: string): Promise<any> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function acquireLock(path: string): Promise<string | undefined> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const temp = `${path}.${token}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })); } finally { await file.close(); }
      // The exclusive link publishes complete metadata, even if the process
      // exits between creating and writing the private temporary file.
      await link(temp, path);
      return token;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { await rm(temp, { force: true }); }
    let lock: any;
    try { lock = await optionalJson(path); }
    catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
    if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return undefined;
    try { process.kill(lock.pid, 0); return undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined; }
    // Serialize stale-owner recovery. This lock uses the same dead-pid rule,
    // so a process that dies during recovery cannot leave a permanent guard.
    const recoveryPath = `${path}.recovery`;
    const recovery = await acquireLock(recoveryPath);
    if (!recovery) return undefined;
    try {
      const current = await optionalJson(path);
      if (current && current.token !== lock.token) return undefined;
      if (current) {
        const stale = `${path}.${randomUUID()}.stale`;
        await rename(path, stale);
        await rm(stale, { force: true });
      }
    } finally { await releaseLock(recoveryPath, recovery); }
  }
  return undefined;
}
export async function releaseLock(path: string, token: string): Promise<void> {
  if ((await optionalJson(path))?.token === token) await rm(path, { force: true });
}

async function* sessionFiles(root: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}
async function checkpoints(path: string, offset: number): Promise<{ head: string; tail: string }> {
  const file = await open(path, "r");
  try {
    const length = Math.min(offset, 4096);
    const head = Buffer.alloc(length), tail = Buffer.alloc(length);
    await file.read(head, 0, length, 0); await file.read(tail, 0, length, offset - length);
    return { head: hash(head), tail: hash(tail) };
  } finally { await file.close(); }
}
const empty = (): Metrics => [0, 0, 0, 0, 0, 0, null, null];
function add(target: Metrics, value: Metrics) {
  for (let i = 0; i < 6; i++) target[i]! += value[i]!;
  for (const i of [6, 7]) if (value[i] !== null) target[i] = (target[i] ?? 0) + value[i]!;
}
const bucketKey = (row: Bucket) => JSON.stringify(row.slice(0, 3));
function addBucket(map: Map<string, Bucket>, time: string | number, provider: string, model: string, value: Metrics) {
  const key = JSON.stringify([time, provider, model]);
  const row = map.get(key);
  if (!row) map.set(key, [time, provider, model, ...value]);
  else { const metrics = row.slice(3) as Metrics; add(metrics, value); row.splice(3, 8, ...metrics); }
}
function pricing(models: Model<any>[]) {
  const catalog = new Map<string, Model<any>[]>();
  for (const model of [...models].sort((a, b) => a.provider.localeCompare(b.provider))) {
    if (![model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite, ...(model.cost.tiers ?? []).flatMap(t => [t.input, t.output, t.cacheRead, t.cacheWrite])].some(rate => rate > 0)) continue;
    const list = catalog.get(model.id) ?? []; list.push(model); catalog.set(model.id, list);
  }
  return (id: string, provider: string) => {
    const list = catalog.get(id) ?? [];
    return list.find(m => m.provider === provider) ?? list.find(m => m.provider === "anthropic") ?? list.find(m => m.provider === "openai") ?? list[0];
  };
}
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
function metrics(usage: any, model: Model<any> | undefined): Metrics {
  const input = number(usage.input), output = number(usage.output), cacheRead = number(usage.cacheRead), cacheWrite = number(usage.cacheWrite);
  const cost = number(usage.cost?.total);
  const priced = (noCache: boolean) => calculateCost(model!, {
    input: input + (noCache ? cacheRead : 0), output, cacheRead: noCache ? 0 : cacheRead, cacheWrite,
    cacheWrite1h: Math.min(cacheWrite, number(usage.cacheWrite1h)), totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  } as Usage).total;
  const actual = cost > 0 ? cost : model ? priced(false) : null;
  const savings = model ? Math.max(0, priced(true) - (actual ?? 0)) : null;
  return [1, input, output, cacheRead, cacheWrite, cost, actual, savings];
}
function timestamp(value: unknown): number | undefined {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? time : undefined;
}
function dayFormatter(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (time: number) => formatter.format(time);
}
async function readIndex(path: string, previous: FileIndex | undefined, timeZone: string, models: ReturnType<typeof pricing>, now: number, onRead?: HistoryOptions["onRead"]): Promise<FileIndex | undefined> {
  const before = await stat(path);
  if (previous && before.size === previous.size && before.mtimeMs === previous.mtime) return previous;
  let append = false;
  if (previous && before.size > previous.size) {
    const check = await checkpoints(path, previous.offset);
    append = check.head === previous.head && check.tail === previous.tail;
  }
  const entry: FileIndex = append ? structuredClone(previous!) : { generation: 0, size: 0, mtime: 0, offset: 0, cwd: "", head: "", tail: "", daily: [], hourly: [] };
  const daily = new Map(entry.daily.map(row => [bucketKey(row), row]));
  const hourly = new Map(entry.hourly.filter(row => Number(row[0]) >= now - 7 * 86400000).map(row => [bucketKey(row), row]));
  const day = dayFormatter(timeZone);
  const start = entry.offset;
  onRead?.(path, start);
  let pending = Buffer.alloc(0), count = 0;
  if (before.size > start) for await (const chunk of createReadStream(path, { start, end: before.size - 1, highWaterMark: 64 * 1024 })) {
    const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk as Buffer;
    let from = 0, end: number;
    while ((end = bytes.indexOf(10, from)) !== -1) {
      const line = bytes.subarray(from, end);
      const header = entry.offset === 0;
      entry.offset += end - from + 1;
      from = end + 1;
      if (header || line.includes('"usage"')) {
        let value;
        try { value = JSON.parse(line.toString("utf8")); } catch { continue; }
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        if (header && value.type === "session") {
          entry.cwd = typeof value.cwd === "string" ? value.cwd : "";
          if (value.parentSession) entry.fork = timestamp(value.timestamp);
        }
        const message = value.message;
        if (value.type !== "message" || message?.role !== "assistant" || !message.usage || !["input", "output", "cacheRead", "cacheWrite"].some(k => typeof message.usage[k] === "number") || typeof message.provider !== "string" || typeof message.model !== "string") continue;
        const time = timestamp(message.timestamp);
        if (time === undefined || (entry.fork !== undefined && time < entry.fork)) continue;
        const usage = metrics(message.usage, models(message.model, message.provider));
        addBucket(daily, day(time), message.provider, message.model, usage);
        const hour = Math.floor(time / 3600000) * 3600000;
        if (hour >= now - 7 * 86400000 && hour <= now) addBucket(hourly, hour, message.provider, message.model, usage);
      }
      if (++count % 1000 === 0) await yieldLoop();
    }
    pending = Buffer.from(bytes.subarray(from));
  }
  const after = await stat(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return previous;
  entry.size = before.size; entry.mtime = before.mtimeMs;
  Object.assign(entry, await checkpoints(path, entry.offset));
  entry.daily = [...daily.values()]; entry.hourly = [...hourly.values()];
  return entry;
}

const providerLabel = (id: string) => id.startsWith("openai-codex") ? "Codex" : id === "claude-bridge" ? "Claude" : id === "openai" ? "OpenAI" : id === "anthropic" ? "Anthropic" : id;
const fields = (metrics: Metrics) => ({ messages: metrics[0], input: metrics[1], output: metrics[2], cacheRead: metrics[3], cacheWrite: metrics[4], cost: metrics[5], estimatedCost: metrics[6], cacheSavings: metrics[7] });
export function buildHistory(cache: Cache, root: string, now: number) {
  const daily = new Map<string, Bucket>(), hourly = new Map<string, Bucket>();
  const projects = new Map<string, { day: string; project: string; sessions: number; messages: number; tokens: number; cost: number; estimatedCost: number | null }>();
  for (const [path, entry] of Object.entries(cache.files)) {
    if (!within(path, root) || entry.generation !== cache.generation) continue;
    const projectDays = new Set<string>();
    for (const row of entry.daily) {
      addBucket(daily, row[0], row[1], row[2], row.slice(3) as Metrics);
      const day = String(row[0]), key = JSON.stringify([day, entry.cwd]);
      const project = projects.get(key) ?? { day, project: entry.cwd, sessions: 0, messages: 0, tokens: 0, cost: 0, estimatedCost: null };
      if (!projectDays.has(day)) { project.sessions++; projectDays.add(day); }
      project.messages += row[3]; project.tokens += row[4] + row[5] + row[6] + row[7]; project.cost += row[8];
      if (row[9] !== null) project.estimatedCost = (project.estimatedCost ?? 0) + row[9];
      projects.set(key, project);
    }
    for (const row of entry.hourly) if (Number(row[0]) >= now - 7 * 86400000 && Number(row[0]) <= now) addBucket(hourly, row[0], row[1], row[2], row.slice(3) as Metrics);
  }
  const sort = (a: Bucket, b: Bucket) => String(a[0]).localeCompare(String(b[0])) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]);
  const providers = [...new Set([...daily.values()].map(row => row[1]))].sort().slice(0, 64).map(id => ({ id, label: providerLabel(id) }));
  return { generatedAt: now, source: `pi-sessions:${root}`, timeZone: cache.timeZone,
    firstDay: [...daily.values()].sort(sort)[0]?.[0] as string | undefined, providers,
    daily: [...daily.values()].sort(sort).map(row => ({ day: String(row[0]), provider: row[1], model: row[2], ...fields(row.slice(3) as Metrics) })),
    hourly: [...hourly.values()].sort(sort).map(row => ({ hour: Number(row[0]), provider: row[1], model: row[2], ...fields(row.slice(3) as Metrics) })),
    projects: [...projects.values()].sort((a, b) => a.day.localeCompare(b.day) || a.project.localeCompare(b.project)),
  };
}
export function capSnapshot(snapshot: { version: number; producer: string; updatedAt: number; history: ReturnType<typeof buildHistory> }, byteCap = 16 * 1024 * 1024) {
  const h = snapshot.history;
  const dropDay = (day: string) => {
    h.daily = h.daily.filter(row => row.day > day); h.projects = h.projects.filter(row => row.day > day);
    const localDay = dayFormatter(h.timeZone);
    h.hourly = h.hourly.filter(row => localDay(row.hour) > day);
    h.firstDay = h.daily[0]?.day;
  };
  while (h.daily.length > 50000 || h.hourly.length > 10000 || h.projects.length > 20000 || Buffer.byteLength(JSON.stringify(snapshot)) > byteCap) {
    const day = [h.daily[0]?.day, h.projects[0]?.day, h.hourly[0] ? dayFormatter(h.timeZone)(h.hourly[0].hour) : undefined].filter(Boolean).sort()[0];
    if (!day) break;
    dropDay(day);
  }
  return snapshot;
}

export async function indexHistory(options: HistoryOptions): Promise<IndexResult> {
  if (!await hubExists(options.hubDir)) return { status: "disabled", readFiles: 0 };
  const now = options.now ?? Date.now(), timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const root = await realpath(options.root);
  const pricingHash = hash(JSON.stringify(options.models.map(m => [m.provider, m.id, m.cost]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
  const dir = join(options.agentDir, "pi-accounts"), statePath = join(dir, "usage-index-state.json"), lockPath = join(dir, "usage-index.lock"), cachePath = join(dir, "usage-index.json");
  const recent = async () => {
    const state = await optionalJson(statePath);
    return !options.force && state?.root === root && state.timeZone === timeZone && state.pricingHash === pricingHash && now - state.lastCompletedAt < 300000;
  };
  if (await recent()) return { status: "coalesced", readFiles: 0 };
  await mkdir(dir, { recursive: true });
  const token = await acquireLock(lockPath);
  if (!token) return { status: "locked", readFiles: 0 };
  try {
    if (await recent()) return { status: "coalesced", readFiles: 0 };
    let cache: Cache = await optionalJson(cachePath);
    if (!cache || cache.version !== 1) cache = { version: 1, generation: 1, timeZone, pricingHash, files: {} };
    else if (cache.timeZone !== timeZone || cache.pricingHash !== pricingHash) {
      cache.generation++; cache.timeZone = timeZone; cache.pricingHash = pricingHash;
    }
    const seen = new Set<string>(), prices = pricing(options.models);
    let readFiles = 0;
    for await (const path of sessionFiles(root)) {
      seen.add(path);
      try {
        const previous = cache.files[path]?.generation === cache.generation ? cache.files[path] : undefined;
        const entry = await readIndex(path, previous, timeZone, prices, now, (file, offset) => { readFiles++; options.onRead?.(file, offset); });
        if (entry) { entry.generation = cache.generation; cache.files[path] = entry; }
        else if (cache.files[path]) delete cache.files[path];
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await yieldLoop();
    }
    for (const path of Object.keys(cache.files)) if (within(path, root) && !seen.has(path)) delete cache.files[path];
    const snapshot = capSnapshot({ version: 1, producer: "pi-accounts", updatedAt: now, history: buildHistory(cache, root, now) });
    const cacheBytes = Buffer.byteLength(JSON.stringify(cache));
    if (cacheBytes > 32 * 1024 * 1024) throw new Error("Usage index exceeds 32 MiB.");
    await atomicJson(cachePath, cache);
    try { await mkdir(join(options.hubDir, "usage")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await atomicJson(join(options.hubDir, "usage/pi-accounts-history.json"), snapshot);
    await atomicJson(statePath, { lastCompletedAt: options.now ?? Date.now(), root, timeZone, pricingHash });
    return { status: "completed", readFiles, files: seen.size, cacheBytes, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)) };
  } finally { await releaseLock(lockPath, token); }
}
