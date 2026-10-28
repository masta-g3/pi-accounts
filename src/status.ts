import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Account, QuotaWindow, Usage } from "./accounts.ts";

export const REFRESH_MS = 5 * 60000;
export type QuotaSnapshot = { usage?: Usage; fetchedAt?: number; checkedAt: number; error?: boolean };

function countdown(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.ceil(minutes / 60)}h`;
  return `${Math.ceil(minutes / 1440)}d`;
}

export function quotaStatus(
  accounts: Account[], activeProvider: string | undefined,
  snapshot: (account: Account) => QuotaSnapshot | undefined,
  theme: Pick<Theme, "fg">, width: number, now = Date.now(),
): string | undefined {
  if (!accounts.length) return undefined;
  const active = accounts.find(account => account.provider === activeProvider);
  const row = (account: Account) => {
    const state = snapshot(account);
    const isActive = account.provider === activeProvider;
    const fg: Theme["fg"] = (color, text) => theme.fg(isActive ? color : "dim", text);
    const stale = Boolean(state?.usage && (state.error || state.fetchedAt === undefined || now - state.fetchedAt >= REFRESH_MS));
    // Each bar is followed by its reset countdown, which also tells the windows apart.
    const bar = (window: QuotaWindow) => {
      if (window.reset <= now) return fg("dim", "?????");
      if (window.remaining === 0) return fg(stale ? "dim" : "error", `⏳${countdown(window.reset - now)}`);
      const filled = Math.max(1, Math.min(5, Math.round(window.remaining / 20)));
      return fg(stale ? "dim" : window.remaining <= 25 ? "warning" : "text", "▰".repeat(filled))
        + fg("dim", "▱".repeat(5 - filled) + ` ${countdown(window.reset - now)}`);
    };
    const marker = isActive ? "●" : "";
    const label = fg("accent", `${marker}${account.slot}${stale ? "~" : ""}`);
    if (!state?.usage) return `${label} ${state?.error ? fg("warning", "⚠") : fg("dim", "·····")}`;
    const resets = state.usage.resets ? fg("accent", ` ↻${state.usage.resets}`) : "";
    return `${label} ${state.usage.windows.map(bar).join(" ")}${resets}`;
  };
  const layout = (shown: Account[]) => (["codex", "claude"] as const).flatMap(kind => {
    const members = shown.filter(account => account.kind === kind);
    if (!members.length) return [];
    return [theme.fg(members.some(account => account.provider === activeProvider) ? "muted" : "dim", `${kind === "codex" ? "Codex" : "Claude"} `) + members.map(row).join(theme.fg("dim", " · "))];
  }).join(theme.fg("dim", "  │  "));
  const full = layout(accounts);
  if (visibleWidth(full) <= width) return full;
  const current = layout([active ?? accounts[0]]);
  const hidden = accounts.length > 1 ? theme.fg("dim", ` +${accounts.length - 1}`) : "";
  if (visibleWidth(current + hidden) <= width) return current + hidden;
  return truncateToWidth(current, Math.max(0, width));
}
