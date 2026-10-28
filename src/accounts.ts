import { readFileSync } from "node:fs";

export const NATIVE = "openai-codex";
export type Account = { kind: "codex" | "claude"; slot: number; provider: string; label: string; accountId?: string };
type RecordValue = Record<string, unknown>;
export type QuotaWindow = { label: "5h" | "week"; remaining: number; reset: number };
export type Usage = { tier?: string; windows: QuotaWindow[]; resets?: number };

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 48);
}

export function providerFor(slot: number): string {
  return slot === 1 ? NATIVE : `${NATIVE}-account-${slot}`;
}

export function slotFor(provider: string): number | undefined {
  if (provider === NATIVE) return 1;
  const match = /^openai-codex-account-([2-9]|[1-9]\d+)$/.exec(provider);
  const slot = match ? Number(match[1]) : undefined;
  return Number.isSafeInteger(slot) ? slot : undefined;
}

export function tokenIdentity(access: string): { email?: string; accountId?: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
  if (!record(payload)) return {};
  const profile = payload["https://api.openai.com/profile"];
  const auth = payload["https://api.openai.com/auth"];
  const email = payload.email ?? (record(profile) ? profile.email : undefined);
  return {
    email: typeof email === "string" ? cleanLabel(email) || undefined : undefined,
    accountId: record(auth) && typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
  };
}

export function accountsFromAuth(value: unknown): Account[] {
  if (!record(value)) throw new Error("Pi auth.json must contain an object.");
  return Object.entries(value).flatMap(([provider, credential]) => {
    const slot = slotFor(provider);
    if (!slot || !record(credential) || credential.type !== "oauth" || typeof credential.access !== "string" || typeof credential.refresh !== "string" || typeof credential.expires !== "number") return [];
    const identity = tokenIdentity(credential.access);
    return [{
      kind: "codex" as const, slot, provider, label: identity.email ?? `Account ${slot}`,
      accountId: typeof credential.accountId === "string" ? credential.accountId : identity.accountId,
    }];
  }).sort((a, b) => a.slot - b.slot);
}

export function readAccounts(path: string): Account[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Pi auth.json contains invalid JSON. Repair it before using /accounts.");
  }
  return accountsFromAuth(value);
}

export function parseClaudeUsage(value: unknown): Usage {
  if (!record(value)) throw new Error("Quota unavailable: unrecognized response.");
  const windows: QuotaWindow[] = [];
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "week"]] as const) {
    const entry = value[key];
    if (!record(entry) || typeof entry.utilization !== "number" || !Number.isFinite(entry.utilization)
      || entry.utilization < 0 || entry.utilization > 100 || typeof entry.resets_at !== "string") continue;
    const reset = Date.parse(entry.resets_at);
    if (Number.isFinite(reset)) windows.push({ label, remaining: 100 - entry.utilization, reset });
  }
  if (!windows.length) throw new Error("No supported quota windows returned.");
  return { windows };
}

export function parseUsage(value: unknown, now = Date.now()): Usage {
  if (!record(value) || !record(value.rate_limit)) throw new Error("Quota unavailable: unrecognized response.");
  const windows: QuotaWindow[] = [];
  for (const [seconds, label] of [[18000, "5h"], [604800, "week"]] as const) {
    const entry = Object.values(value.rate_limit).find(v => record(v) && v.limit_window_seconds === seconds);
    if (!record(entry) || typeof entry.used_percent !== "number" || !Number.isFinite(entry.used_percent) || entry.used_percent < 0 || entry.used_percent > 100) continue;
    const reset = typeof entry.reset_at === "number" ? entry.reset_at * 1000
      : typeof entry.reset_after_seconds === "number" ? now + entry.reset_after_seconds * 1000 : NaN;
    if (!Number.isFinite(reset) || reset <= 0) continue;
    windows.push({ label, remaining: 100 - entry.used_percent, reset });
  }
  if (!windows.length) throw new Error("No supported quota windows returned.");
  const credits = value.rate_limit_reset_credits;
  const resets = record(credits) && typeof credits.available_count === "number" ? credits.available_count : undefined;
  return { tier: typeof value.plan_type === "string" ? cleanLabel(value.plan_type) : undefined, windows, resets };
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

function resetAt(reset: number, now: number): string {
  const date = new Date(reset);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return date.toDateString() === new Date(now).toDateString() ? time
    : `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** Picker detail: plan tier, then one line per window with its local reset time. */
export function usageDetails(usage: Usage, now = Date.now()): string[] {
  return [...(usage.tier ? [usage.tier] : []), ...usage.windows.map(w => w.reset <= now ? `${w.label} reset · reopen to refresh`
    : `${w.label} ${w.remaining === 0 ? "blocked" : `${Number(w.remaining.toFixed(1))}% left`} · resets ${resetAt(w.reset, now)} (in ${duration(w.reset - now)})`)];
}

export function usageText(usage: Usage, now = Date.now()): string {
  return usage.windows.map(w => w.reset <= now ? `${w.label} reset · reopen to refresh`
    : w.remaining === 0 ? `${w.label} blocked · resets in ${duration(w.reset - now)}`
    : `${w.label} ${Number(w.remaining.toFixed(1))}% left`).join(" · ");
}

export function lastModel<T extends { id: string; provider: string }>(
  branch: readonly unknown[], provider: string, available: T[], scope: readonly { model: { id: string; provider: string } }[],
): T | undefined {
  const allowed = (model: T) => !scope.length || scope.some(item => item.model.provider === model.provider && item.model.id === model.id);
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as { type?: string; provider?: string; modelId?: string; message?: { role?: string; provider?: string; model?: string } };
    const modelId = entry.type === "model_change" && entry.provider === provider ? entry.modelId
      : entry.type === "message" && entry.message?.role === "assistant" && entry.message.provider === provider ? entry.message.model : undefined;
    if (modelId) {
      const model = available.find(item => item.provider === provider && item.id === modelId);
      return model && allowed(model) ? model : undefined;
    }
  }
  return undefined;
}

export function switchTarget<T extends { id: string; provider: string }>(
  current: { id: string; provider: string } | undefined,
  provider: string,
  available: T[],
  scope: readonly { model: { id: string; provider: string } }[],
): T {
  if (!current || !slotFor(current.provider)) throw new Error("Select a Codex model with /model first.");
  const target = available.find(m => m.provider === provider && m.id === current.id);
  if (!target) throw new Error("This account is not available for the current model. Sign in with /login first.");
  if (scope.length && !scope.some(({ model }) => model.provider === provider && model.id === current.id)) {
    throw new Error("This account is outside the model scope. Enable it in /scoped-models first.");
  }
  return target;
}
