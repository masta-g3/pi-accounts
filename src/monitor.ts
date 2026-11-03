import type { Account, Usage } from "./accounts.ts";
import { REFRESH_MS, type QuotaSnapshot } from "./status.ts";

const FORCED_REUSE_MS = 60000;

type Entry = { identity: string; value?: QuotaSnapshot; pending?: Promise<Usage>; failure?: unknown };
const identity = (account: Account) => JSON.stringify([account.accountId, account.label]);

// Keep the newest successful reading, and its error only when a later attempt failed.
export function mergeQuota(a: QuotaSnapshot | undefined, b: QuotaSnapshot | undefined): QuotaSnapshot | undefined {
  if (!a || !b) return a ?? b;
  const success = (b.fetchedAt ?? -Infinity) > (a.fetchedAt ?? -Infinity) ? b : a;
  const latest = b.checkedAt > a.checkedAt ? b : a;
  const failed = latest.error && latest.checkedAt > (success.fetchedAt ?? -Infinity);
  return { ...(success.usage ? { usage: success.usage } : {}), ...(success.fetchedAt !== undefined ? { fetchedAt: success.fetchedAt } : {}),
    checkedAt: Math.max(a.checkedAt, b.checkedAt), ...(failed ? { error: true, errorMessage: latest.errorMessage } : {}) };
}

export class UsageMonitor {
  private readonly entries = new Map<string, Entry>();
  private readonly controller = new AbortController();
  private readonly fetch: (account: Account, signal: AbortSignal) => Promise<Usage>;
  private readonly onChange: () => void;
  private readonly now: () => number;
  private readonly shared?: (account: Account) => Promise<QuotaSnapshot | undefined>;

  constructor(fetch: (account: Account, signal: AbortSignal) => Promise<Usage>, onChange: () => void, now = Date.now,
    shared?: (account: Account) => Promise<QuotaSnapshot | undefined>) {
    this.fetch = fetch;
    this.onChange = onChange;
    this.now = now;
    this.shared = shared;
  }

  // Another session's attempt counts when it is recent and happened after any expired window reset.
  private reusable(state: QuotaSnapshot, force: boolean): boolean {
    const age = this.now() - state.checkedAt;
    if (age < 0 || age >= (force ? FORCED_REUSE_MS : REFRESH_MS) || (!state.usage && !state.error)) return false;
    return (state.usage?.windows ?? []).every(window => window.reset > this.now() || state.checkedAt > window.reset);
  }

  snapshot(account: Account): QuotaSnapshot | undefined {
    const entry = this.entries.get(account.provider);
    return entry?.identity === identity(account) ? entry.value : undefined;
  }

  retain(accounts: Account[]): void {
    for (const provider of this.entries.keys()) {
      if (!accounts.some(account => account.provider === provider)) this.entries.delete(provider);
    }
  }

  load(account: Account, force = false): Promise<Usage> {
    if (this.controller.signal.aborted) return Promise.reject(this.controller.signal.reason);
    const previous = this.entries.get(account.provider);
    const entry = previous?.identity === identity(account) ? previous : undefined;
    if (entry?.pending) return entry.pending;
    if (entry?.value && !force && this.now() - entry.value.checkedAt < REFRESH_MS
      && (entry.value.error || !entry.value.usage?.windows.some(window => window.reset <= this.now()))) {
      return entry.value.error ? Promise.reject(entry.failure) : Promise.resolve(entry.value.usage!);
    }
    // checkedAt advances only when an attempt completes, so an in-flight request never looks fresh in the ledger.
    const next: Entry = { identity: identity(account), value: entry?.value };
    this.entries.set(account.provider, next);
    const adopt = async (): Promise<Usage | undefined> => {
      const state = mergeQuota(next.value, await this.shared?.(account).catch(() => undefined));
      this.controller.signal.throwIfAborted();
      if (!state || !this.reusable(state, force)) return undefined;
      const failure = state.error || !state.usage ? new Error(state.errorMessage ?? "Quota unavailable.") : undefined;
      if (this.entries.get(account.provider) === next) {
        next.value = state;
        next.failure = failure;
        this.onChange();
      }
      if (failure) throw failure;
      return state.usage;
    };
    const fetched = () => this.fetch(account, this.controller.signal).then(usage => {
      this.controller.signal.throwIfAborted();
      if (this.entries.get(account.provider) === next) {
        next.value = { usage, fetchedAt: this.now(), checkedAt: this.now() };
        this.onChange();
      }
      return usage;
    }, error => {
      if (!this.controller.signal.aborted && this.entries.get(account.provider) === next) {
        const message = error instanceof Error ? error.message : "";
        const safe = /^(Sign in again with \/login\.|Account identity unavailable\. Sign in again\.|Account changed\. Reopen \/accounts\.|Claude login unavailable\. Run Claude Code to sign in\.|Claude login expired; it refreshes the next time Claude runs\.|Quota unavailable \(HTTP \d{3}\)\.)$/.test(message);
        next.value = { ...next.value, checkedAt: this.now(), error: true, errorMessage: safe ? message : "Quota unavailable." };
        next.failure = error;
        this.onChange();
      }
      throw error;
    });
    const pending = (this.shared ? adopt().then(usage => usage ?? fetched()) : fetched()).finally(() => { next.pending = undefined; });
    next.pending = pending;
    return pending;
  }

  stop(): void {
    this.controller.abort();
    this.entries.clear();
  }
}
