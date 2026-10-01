import { join } from "node:path";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NATIVE, providerFor, readAccounts, slotFor, switchTarget, type Account } from "./accounts.ts";
import { accountProvider } from "./provider.ts";
import { ADD_ACCOUNT, createPicker, type PickerChoice } from "./picker.ts";
import { fetchUsage } from "./quota.ts";
import { UsageMonitor } from "./monitor.ts";
import { quotaStatus } from "./status.ts";

export default function codexAccounts(pi: ExtensionAPI): void {
  const native = openaiCodexProvider();
  const registered = new Set<string>();
  const accounts = () => readAccounts(join(getAgentDir(), "auth.json"));
  const register = (slot: number) => {
    const provider = providerFor(slot);
    if (provider === NATIVE || registered.has(provider)) return;
    pi.registerProvider(accountProvider(native, provider, `OpenAI Codex · Account ${slot}`));
    registered.add(provider);
  };
  const syncAccounts = () => {
    const found = accounts();
    found.forEach(account => register(account.slot));
    return found;
  };
  let visibleAccounts: Account[] = [];
  let sessionContext: ExtensionContext | undefined;
  let monitor: UsageMonitor | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const status = (ctx = sessionContext) => {
    if (!ctx || ctx.mode !== "tui") return;
    ctx.ui.setStatus("codex-accounts", quotaStatus(visibleAccounts, ctx.model?.provider,
      account => monitor?.snapshot(account), ctx.ui.theme, process.stdout.columns ?? 80));
  };
  const tick = () => {
    const ctx = sessionContext;
    if (!ctx || ctx.mode !== "tui") return;
    if (!slotFor(ctx.model?.provider ?? "")) { status(ctx); return; }
    try {
      visibleAccounts = syncAccounts();
    } catch {
      visibleAccounts = [];
      monitor?.retain([]);
      ctx.ui.setStatus("codex-accounts", "Codex · quota unavailable · check auth.json");
      return;
    }
    monitor?.retain(visibleAccounts);
    status(ctx);
    for (const account of visibleAccounts) {
      // Fetch failures are represented by unknown/stale bars, not repeated notifications.
      void monitor?.load(account).catch(() => {});
    }
  };
  const resize = () => status();
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    process.stdout.off("resize", resize);
    monitor?.stop();
    monitor = undefined;
    sessionContext = undefined;
  };

  syncAccounts();
  pi.on("session_start", (_event, ctx) => {
    stop();
    sessionContext = ctx;
    monitor = new UsageMonitor((account, signal) => fetchUsage(account,
      async provider => (await ctx.modelRegistry.getProviderAuth(provider))?.auth.apiKey, signal), () => status());
    if (ctx.mode !== "tui") return;
    tick();
    timer = setInterval(tick, 30000);
    timer.unref();
    process.stdout.on("resize", resize);
  });
  pi.on("model_select", (_event, ctx) => { sessionContext = ctx; tick(); });
  pi.on("session_shutdown", (_event, ctx) => { stop(); ctx.ui.setStatus("codex-accounts", undefined); });

  pi.registerCommand("codex", {
    description: "Choose a Codex account, inspect quota, or add an account",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/codex requires Pi's terminal UI. Use /model and /login in other interactive clients.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current response to finish before switching accounts.", "info");
        return;
      }
      try {
        const found = syncAccounts();
        visibleAccounts = found;
        monitor?.retain(found);
        status(ctx);
        const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: false });
        const chosen = await ctx.ui.custom<PickerChoice | undefined>((tui, theme, _keys, done) =>
          createPicker(found, ctx.model?.provider, theme, () => tui.requestRender(), done,
            account => monitor!.load(account, true), settings.getGlobalSettings().defaultProvider),
        );
        if (!chosen) return;
        if (chosen === ADD_ACCOUNT) {
          let slot = 1;
          while (found.some(account => account.slot === slot)) slot++;
          register(slot);
          const command = `/login ${providerFor(slot)}`;
          // Do not replace a draft that was inserted while the picker was open.
          const hasDraft = Boolean(ctx.ui.getEditorText().trim());
          if (!hasDraft) ctx.ui.setEditorText(command);
          ctx.ui.notify(`${hasDraft ? `Run ${command}` : "Press Enter"} to sign in, then reopen /codex. Choose the intended account in your browser.`, "info");
          return;
        }
        if (!ctx.isIdle()) throw new Error("A response started while the picker was open. Try /codex when it finishes.");
        const provider = typeof chosen === "string" ? chosen : chosen.defaultProvider;
        const selected = found.find(account => account.provider === provider)!;
        const current = accounts().find(account => account.provider === provider);
        if (!current || current.accountId !== selected.accountId || current.label !== selected.label) {
          throw new Error("Account changed while the picker was open. Reopen /codex.");
        }
        if (typeof chosen !== "string") {
          const target = switchTarget(ctx.model, provider, ctx.modelRegistry.getAvailable(), []);
          settings.setDefaultModelAndProvider(target.provider, target.id);
          await settings.flush();
          if (settings.drainErrors().length) throw new Error("Could not save Pi's default account. Check settings.json permissions and syntax.");
          ctx.ui.notify(`Account ${selected.slot} is now the default for new sessions (${target.id}). Existing sessions are unchanged.`, "info");
          return;
        }
        if (provider === ctx.model?.provider) return;
        const target = switchTarget(ctx.model, provider, ctx.modelRegistry.getAvailable(), ctx.scopedModels);
        if (!await pi.setModel(target)) throw new Error("Could not switch accounts. Sign in again with /login.");
        status(ctx);
        ctx.ui.notify(`Using ${selected.label}. Model unchanged.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not open Codex accounts.", "error");
      }
    },
  });
}
