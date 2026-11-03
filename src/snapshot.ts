import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Account, QuotaWindow } from "./accounts.ts";
import { acquireLock, releaseLock } from "./history.ts";
import { mergeQuota } from "./monitor.ts";
import type { QuotaSnapshot } from "./status.ts";

export const hubDirectory = (agentDir: string, env: NodeJS.ProcessEnv = process.env) => resolve(env.PI_AGENT_HUB_DIR || join(agentDir, "pi-agent-hub"));
export async function hubExists(dir: string): Promise<boolean> {
  try { return (await stat(dir)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); } finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export function limitsSnapshot(accounts: Account[], snapshot: (account: Account) => QuotaSnapshot | undefined, now: number) {
  return { version: 1, producer: "pi-accounts", updatedAt: now, accounts: accounts.slice(0, 32).map(account => {
    const state = snapshot(account);
    const provider = account.kind === "codex" ? "Codex" : "Claude";
    return { id: account.provider, key: ledgerKey(account), provider, label: `${provider} ${account.slot}`,
      ...(state?.usage?.tier ? { plan: state.usage.tier } : {}),
      ...(state ? { checkedAt: state.checkedAt } : {}),
      ...(state?.fetchedAt !== undefined ? { fetchedAt: state.fetchedAt } : {}),
      ...(state?.error ? { error: state.errorMessage ?? "Quota unavailable." } : {}),
      ...(state?.usage?.resets !== undefined ? { resetCredits: state.usage.resets } : {}),
      windows: (state?.usage?.windows ?? []).map(window => ({ id: window.label, label: window.label,
        remainingPercent: window.remaining, resetAt: window.reset, durationMs: window.label === "5h" ? 18000000 : 604800000 })),
    };
  }) };
}

// The limits file doubles as a ledger shared by every Pi session, so one
// reading serves all of them and an older session cannot overwrite a newer one.
const ledgerKey = (account: Account) => createHash("sha256")
  .update(JSON.stringify([account.provider, account.accountId, account.label])).digest("hex").slice(0, 16);
const limitsPath = (dir: string) => join(dir, "usage/pi-accounts-limits.json");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

type LedgerEntry = QuotaSnapshot & { key: string };
export async function readLedger(dir: string): Promise<Map<string, LedgerEntry>> {
  let value: any;
  try { value = JSON.parse(await readFile(limitsPath(dir), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return new Map(); throw error; }
  const ledger = new Map<string, LedgerEntry>();
  for (const item of Array.isArray(value?.accounts) ? value.accounts : []) {
    if (typeof item?.id !== "string" || typeof item.key !== "string" || !finite(item.checkedAt)) continue;
    const windows: QuotaWindow[] = (Array.isArray(item.windows) ? item.windows : [])
      .filter((window: any) => (window?.id === "5h" || window?.id === "week") && finite(window.remainingPercent) && finite(window.resetAt))
      .map((window: any) => ({ label: window.id, remaining: window.remainingPercent, reset: window.resetAt }));
    ledger.set(item.id, { key: item.key, checkedAt: item.checkedAt,
      ...(finite(item.fetchedAt) ? { fetchedAt: item.fetchedAt, usage: { windows,
        ...(typeof item.plan === "string" ? { tier: item.plan } : {}), ...(finite(item.resetCredits) ? { resets: item.resetCredits } : {}) } } : {}),
      ...(typeof item.error === "string" ? { error: true, errorMessage: item.error } : {}) });
  }
  return ledger;
}

export function ledgerQuota(ledger: Map<string, LedgerEntry>, account: Account): QuotaSnapshot | undefined {
  const entry = ledger.get(account.provider);
  if (entry?.key !== ledgerKey(account)) return undefined;
  const { key: _, ...quota } = entry;
  return quota;
}

export async function publishLimits(dir: string, accounts: Account[], snapshot: (account: Account) => QuotaSnapshot | undefined, now = Date.now()): Promise<boolean> {
  if (!await hubExists(dir)) return false;
  try { await mkdir(join(dir, "usage")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const lock = join(dir, "usage/.pi-accounts-limits.lock");
  let token: string | undefined;
  for (let attempt = 0; attempt < 40 && !(token = await acquireLock(lock)); attempt++) await sleep(25);
  // Another session holds the ledger; its write or this session's next publish catches up.
  if (!token) return false;
  try {
    const ledger = await readLedger(dir);
    await atomicJson(limitsPath(dir), limitsSnapshot(accounts, account => mergeQuota(snapshot(account), ledgerQuota(ledger, account)), now));
  } finally { await releaseLock(lock, token); }
  return true;
}
