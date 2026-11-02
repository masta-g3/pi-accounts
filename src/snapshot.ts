import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Account } from "./accounts.ts";
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
    return { id: account.provider, provider, label: `${provider} ${account.slot}`,
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

export async function publishLimits(dir: string, accounts: Account[], snapshot: (account: Account) => QuotaSnapshot | undefined, now = Date.now()): Promise<boolean> {
  if (!await hubExists(dir)) return false;
  try { await mkdir(join(dir, "usage")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await atomicJson(join(dir, "usage/pi-accounts-limits.json"), limitsSnapshot(accounts, snapshot, now));
  return true;
}
