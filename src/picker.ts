import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
import { type Account, cleanLabel, type Usage, usageDetails, usageText } from "./accounts.ts";

export const ADD_ACCOUNT = "+add";
export type PickerChoice = string | { provider: string; model?: string } | { defaultProvider: string; model?: string } | { logoutProvider: string };

export function createPicker(
  accounts: Account[],
  activeProvider: string | undefined,
  theme: Pick<Theme, "fg" | "bold">,
  requestRender: () => void,
  done: (choice: PickerChoice | undefined) => void,
  loadUsage: (account: Account, signal: AbortSignal) => Promise<Usage>,
  defaultProvider?: string,
) {
  const controller = new AbortController();
  const details = new Map<string, string[]>();
  const defaultTag = (account: Account) => account.provider === defaultProvider ? "default · " : "";
  const items: SelectItem[] = accounts.map(account => ({
    value: account.provider,
    label: `${account.provider === activeProvider ? "●" : "○"} ${account.label} · ${account.kind === "codex" ? "Codex" : "Claude"} ${account.slot}`,
    description: defaultTag(account) + "Checking quota…",
  }));
  items.push({ value: ADD_ACCOUNT, label: "+ Add Codex account", description: "Sign in through Pi" });
  const list = new SelectList(items, 8, {
    selectedPrefix: text => theme.fg("accent", text),
    selectedText: text => theme.fg("accent", text),
    description: text => theme.fg("muted", text),
    scrollInfo: text => theme.fg("dim", text),
    noMatch: text => theme.fg("muted", text),
  }, { maxPrimaryColumnWidth: 42 });
  list.setSelectedIndex(Math.max(0, accounts.findIndex(account => account.provider === activeProvider)));
  const finish = (value?: PickerChoice) => {
    controller.abort();
    done(value);
  };
  list.onSelect = item => finish(item.value);
  list.onCancel = () => finish();

  for (const [index, account] of accounts.entries()) {
    void loadUsage(account, controller.signal).then(usage => {
      if (controller.signal.aborted) return;
      items[index].description = defaultTag(account) + usageText(usage);
      details.set(account.provider, usageDetails(usage));
      requestRender();
    }, error => {
      if (controller.signal.aborted) return;
      items[index].description = defaultTag(account) + "Quota unavailable";
      details.set(account.provider, [error instanceof Error ? cleanLabel(error.message) : "Quota request failed."]);
      requestRender();
    });
  }

  return {
    render(width: number): string[] {
      const selected = list.getSelectedItem();
      const detail = selected?.value === ADD_ACCOUNT ? ["Uses Pi /login. Your current account stays signed in."]
        : details.get(selected?.value ?? "") ?? ["Checking quota… You can switch without waiting."];
      return [
        theme.fg("accent", theme.bold("Accounts")),
        theme.fg("dim", "Codex ↔ Codex keeps the model · Claude uses its last model"),
        "",
        ...list.render(width),
        "",
        ...detail.map(line => theme.fg("muted", line)),
        theme.fg("dim", selected?.value === ADD_ACCOUNT ? "Enter add · Esc close" : "↑↓ · Enter use · d default · l sign out · Esc close"),
      ].map(line => truncateToWidth(line, Math.max(0, width)));
    },
    handleInput(data: string) {
      if (matchesKey(data, "d") || matchesKey(data, "l")) {
        const selected = list.getSelectedItem();
        if (selected && selected.value !== ADD_ACCOUNT) {
          finish(matchesKey(data, "d") ? { defaultProvider: selected.value } : { logoutProvider: selected.value });
        }
        return;
      }
      list.handleInput(data);
      requestRender();
    },
    handleMouse: list.handleMouse.bind(list),
    invalidate() { list.invalidate(); },
    dispose() { controller.abort(); },
  };
}

export function createModelPicker(
  provider: string,
  models: readonly { id: string }[],
  makeDefault: boolean,
  theme: Pick<Theme, "fg" | "bold">,
  requestRender: () => void,
  done: (choice: PickerChoice | undefined) => void,
) {
  const items: SelectItem[] = models.map(model => ({ value: model.id, label: model.id }));
  const list = new SelectList(items, 8, {
    selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
    description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text),
    noMatch: text => theme.fg("muted", text),
  });
  list.onSelect = item => done(makeDefault ? { defaultProvider: provider, model: item.value } : { provider, model: item.value });
  list.onCancel = () => done(undefined);
  return {
    render(width: number): string[] {
      const title = provider === "claude-bridge" ? "Claude models" : "Codex models";
      return [theme.fg("accent", theme.bold(title)), "", ...list.render(width), "", theme.fg("dim", "Enter use · Esc back")]
        .map(line => truncateToWidth(line, Math.max(0, width)));
    },
    handleInput(data: string) { list.handleInput(data); requestRender(); },
    handleMouse: list.handleMouse.bind(list), invalidate() { list.invalidate(); }, dispose() {},
  };
}
