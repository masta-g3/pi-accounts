import type { Account, Usage } from "./accounts.ts";
import { REFRESH_MS, type QuotaSnapshot } from "./status.ts";

type Entry = { identity: string; value: QuotaSnapshot; pending?: Promise<Usage>; failure?: unknown };
const identity = (account: Account) => JSON.stringify([account.accountId, account.label]);

export class UsageMonitor {
  private readonly entries = new Map<string, Entry>();
  private readonly controller = new AbortController();
  private readonly fetch: (account: Account, signal: AbortSignal) => Promise<Usage>;
  private readonly onChange: () => void;
  private readonly now: () => number;

  constructor(fetch: (account: Account, signal: AbortSignal) => Promise<Usage>, onChange: () => void, now = Date.now) {
    this.fetch = fetch;
    this.onChange = onChange;
    this.now = now;
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
    if (entry && !force && this.now() - entry.value.checkedAt < REFRESH_MS
      && (entry.value.error || !entry.value.usage?.windows.some(window => window.reset <= this.now()))) {
      return entry.value.error ? Promise.reject(entry.failure) : Promise.resolve(entry.value.usage!);
    }
    const next: Entry = { identity: identity(account), value: { ...entry?.value, checkedAt: this.now() } };
    this.entries.set(account.provider, next);
    const pending = this.fetch(account, this.controller.signal).then(usage => {
      this.controller.signal.throwIfAborted();
      if (this.entries.get(account.provider) === next) {
        next.value = { usage, fetchedAt: this.now(), checkedAt: this.now() };
        this.onChange();
      }
      return usage;
    }, error => {
      if (!this.controller.signal.aborted && this.entries.get(account.provider) === next) {
        next.value = { ...next.value, checkedAt: this.now(), error: true };
        next.failure = error;
        this.onChange();
      }
      throw error;
    }).finally(() => { next.pending = undefined; });
    next.pending = pending;
    return pending;
  }

  stop(): void {
    this.controller.abort();
    this.entries.clear();
  }
}
