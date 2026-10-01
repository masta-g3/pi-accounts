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
  accounts: Account[],
  activeProvider: string | undefined,
  snapshot: (account: Account) => QuotaSnapshot | undefined,
  theme: Pick<Theme, "fg">,
  width: number,
  now = Date.now(),
): string | undefined {
  const active = accounts.find(account => account.provider === activeProvider);
  if (!active) return undefined;
  const labelsFor = (account: Account): QuotaWindow["label"][] => {
    const usage = snapshot(account)?.usage;
    return (["5h", "week"] as const).filter(label => !usage || usage.windows.some(window => window.label === label));
  };
  const row = (account: Account, labelBars: boolean) => {
    const state = snapshot(account);
    const stale = Boolean(state?.usage && (state.error || state.fetchedAt === undefined || now - state.fetchedAt >= REFRESH_MS));
    const bar = (window: QuotaWindow | undefined) => {
      if (!window) return theme.fg("dim", !state || (!state.usage && !state.error) ? "·····" : "?????");
      if (window.reset <= now) return theme.fg("dim", "?????");
      if (window.remaining === 0) return theme.fg(stale ? "dim" : "error", `⏳${countdown(window.reset - now)}`);
      const filled = Math.max(1, Math.min(5, Math.round(window.remaining / 20)));
      return theme.fg(stale ? "dim" : window.remaining <= 25 ? "warning" : "text", "▰".repeat(filled))
        + theme.fg("dim", "▱".repeat(5 - filled));
    };
    const label = `${account.provider === activeProvider ? "●" : ""}${account.slot}${stale ? "~" : ""}`;
    const bars = labelsFor(account).map(windowLabel =>
      (labelBars ? theme.fg("muted", `${windowLabel} `) : "")
      + bar(state?.usage?.windows.find(window => window.label === windowLabel)));
    return `${theme.fg(account.provider === activeProvider ? "accent" : "muted", label)} ${bars.join(" ")}`;
  };
  const layout = (shown: Account[], compact = false) => {
    const labels = labelsFor(shown[0]);
    const shared = shown.every(account => labelsFor(account).join() === labels.join());
    const legend = labels.map(label => compact && label === "week" ? "wk" : label).join(compact ? "/" : " / ");
    const prefix = shared ? (compact ? `${legend} ` : `Codex · ${legend}  `) : "Codex  ";
    return theme.fg("muted", prefix) + shown.map(account => row(account, !shared)).join(theme.fg("dim", "  │  "));
  };
  const full = layout(accounts);
  if (visibleWidth(full) <= width) return full;
  const current = layout([active]);
  const hidden = accounts.length > 1 ? theme.fg("dim", ` +${accounts.length - 1}`) : "";
  if (visibleWidth(current + hidden) <= width) return current + hidden;
  if (visibleWidth(current) <= width) return current;
  return truncateToWidth(layout([active], true), Math.max(0, width));
}
