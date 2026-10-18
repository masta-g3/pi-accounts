import { join } from "node:path";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { NATIVE, lastModel, providerFor, readAccounts, slotFor, switchTarget, type Account } from "./accounts.ts";
import { CLAUDE, readClaudeAccount, readClaudeCredential } from "./claude.ts";
import { accountProvider } from "./provider.ts";
import { ADD_ACCOUNT, createModelPicker, createPicker, type PickerChoice } from "./picker.ts";
import { fetchClaudeUsage, fetchCodexUsage } from "./quota.ts";
import { UsageMonitor } from "./monitor.ts";
import { quotaStatus } from "./status.ts";

const kindOf = (provider: string | undefined) => provider === CLAUDE ? "claude" : slotFor(provider ?? "") ? "codex" : undefined;

export type AccountsDependencies = {
  readClaudeAccount: typeof readClaudeAccount;
  readClaudeCredential: typeof readClaudeCredential;
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

export default function accountsExtension(pi: ExtensionAPI, dependencies: AccountsDependencies = {
  readClaudeAccount, readClaudeCredential, now: Date.now, setTimeout, clearTimeout,
}): void {
  const native = openaiCodexProvider();
  const registered = new Set<string>();
  const codexAccounts = () => readAccounts(join(getAgentDir(), "auth.json"));
  const register = (slot: number) => {
    const provider = providerFor(slot);
    if (provider === NATIVE || registered.has(provider)) return;
    pi.registerProvider(accountProvider(native, provider, `OpenAI Codex · Account ${slot}`));
    registered.add(provider);
  };
  const syncCodex = () => { const found = codexAccounts(); found.forEach(account => register(account.slot)); return found; };
  const discover = async (ctx: ExtensionContext): Promise<{ accounts: Account[]; claudeError: boolean }> => {
    const accounts = syncCodex();
    if (!ctx.modelRegistry.getAvailable().some(model => model.provider === CLAUDE)) return { accounts, claudeError: false };
    try {
      const claude = await dependencies.readClaudeAccount();
      if (claude) accounts.push(claude);
      return { accounts, claudeError: false };
    } catch {
      return { accounts, claudeError: true };
    }
  };
  let visibleAccounts: Account[] = [];
  let sessionContext: ExtensionContext | undefined;
  let monitor: UsageMonitor | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let deferredClaude: ReturnType<typeof setTimeout> | undefined;
  let lastClaudeCheck = 0;
  let tickGeneration = 0;
  let claudeDiscoveryError = false;
  const status = (ctx = sessionContext) => {
    if (!ctx || ctx.mode !== "tui") return;
    const width = process.stdout.columns ?? 80;
    const warning = claudeDiscoveryError ? ctx.ui.theme.fg("error", "Claude unavailable") : "";
    const suffix = warning ? ctx.ui.theme.fg("dim", "  │  ") + warning : "";
    const quota = quotaStatus(visibleAccounts, ctx.model?.provider, account => monitor?.snapshot(account),
      ctx.ui.theme, Math.max(0, width - visibleWidth(suffix)));
    const text = quota ? quota + suffix : warning || undefined;
    ctx.ui.setStatus("accounts", text ? truncateToWidth(text, width) : undefined);
  };
  const tick = async () => {
    const ctx = sessionContext;
    if (!ctx || ctx.mode !== "tui") return;
    const generation = ++tickGeneration;
    let result: { accounts: Account[]; claudeError: boolean };
    try { result = await discover(ctx); }
    catch {
      if (generation !== tickGeneration || sessionContext !== ctx) return;
      visibleAccounts = [];
      monitor?.retain([]);
      ctx.ui.setStatus("accounts", "Accounts · quota unavailable · check auth.json");
      return;
    }
    if (generation !== tickGeneration || sessionContext !== ctx) return;
    visibleAccounts = result.accounts;
    claudeDiscoveryError = result.claudeError;
    monitor?.retain(visibleAccounts);
    status(ctx);
    for (const account of visibleAccounts) {
      if (account.kind === "claude") {
        const state = monitor?.snapshot(account);
        if (!state || dependencies.now() - state.checkedAt >= 5 * 60000 || state.usage?.windows.some(window => window.reset <= dependencies.now())) lastClaudeCheck = dependencies.now();
      }
      void monitor?.load(account).catch(() => {});
    }
  };
  const refreshClaude = () => {
    const account = visibleAccounts.find(item => item.kind === "claude");
    if (!account || !monitor) return;
    lastClaudeCheck = dependencies.now();
    void monitor.load(account, true).catch(() => {});
  };
  const resize = () => status();
  const stop = () => {
    if (timer) clearInterval(timer);
    if (deferredClaude) dependencies.clearTimeout(deferredClaude);
    timer = undefined; deferredClaude = undefined;
    tickGeneration++;
    claudeDiscoveryError = false;
    process.stdout.off("resize", resize);
    monitor?.stop(); monitor = undefined; sessionContext = undefined;
  };

  syncCodex();
  pi.on("session_start", (_event, ctx) => {
    stop();
    sessionContext = ctx;
    monitor = new UsageMonitor((account, signal) => account.kind === "claude"
      ? fetchClaudeUsage(dependencies.readClaudeCredential, signal)
      : fetchCodexUsage(account, async provider => (await ctx.modelRegistry.getProviderAuth(provider))?.auth.apiKey, signal), () => status());
    if (ctx.mode !== "tui") return;
    void tick();
    timer = setInterval(() => { void tick(); }, 30000); timer.unref();
    process.stdout.on("resize", resize);
  });
  pi.on("model_select", (_event, ctx) => { sessionContext = ctx; void tick(); });
  pi.on("after_provider_response", (_event, ctx) => {
    if (ctx.model?.provider !== CLAUDE || ctx.mode !== "tui") return;
    const wait = 60000 - (dependencies.now() - lastClaudeCheck);
    if (wait <= 0) {
      if (deferredClaude) dependencies.clearTimeout(deferredClaude);
      deferredClaude = undefined;
      refreshClaude();
    } else if (!deferredClaude) {
      deferredClaude = dependencies.setTimeout(() => { deferredClaude = undefined; refreshClaude(); }, wait);
      deferredClaude.unref();
    }
  });
  pi.on("session_shutdown", (_event, ctx) => { stop(); ctx.ui.setStatus("accounts", undefined); });

  const availableFor = (ctx: ExtensionCommandContext, provider: string) => ctx.modelRegistry.getAvailable().filter(model =>
    model.provider === provider && (!ctx.scopedModels.length || ctx.scopedModels.some(item => item.model.provider === provider && item.model.id === model.id)));
  const pickModel = async (ctx: ExtensionCommandContext, provider: string, makeDefault: boolean) => {
    const models = availableFor(ctx, provider);
    if (!models.length) throw new Error(`No ${provider === CLAUDE ? "Claude" : "Codex"} models available. Check ${provider === CLAUDE ? "pi-claude-bridge and " : ""}/scoped-models.`);
    return ctx.ui.custom<PickerChoice | undefined>((tui, theme, _keys, done) =>
      createModelPicker(provider, models, makeDefault, theme, () => tui.requestRender(), done));
  };

  pi.registerCommand("accounts", {
    description: "Choose an account, inspect quota, add Codex, or sign out",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/accounts requires Pi's terminal UI. Use /model and /login in other interactive clients.", "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current response to finish before switching accounts.", "info"); return; }
      try {
        while (true) {
          const discovery = await discover(ctx);
          const found = discovery.accounts;
          visibleAccounts = found; claudeDiscoveryError = discovery.claudeError; monitor?.retain(found); status(ctx);
          const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: false });
          let chosen = await ctx.ui.custom<PickerChoice | undefined>((tui, theme, _keys, done) =>
            createPicker(found, ctx.model?.provider, theme, () => tui.requestRender(), done,
              account => monitor!.load(account, true), settings.getGlobalSettings().defaultProvider));
          if (!chosen) return;
          if (chosen === ADD_ACCOUNT) {
            let slot = 1; while (found.some(account => account.kind === "codex" && account.slot === slot)) slot++;
            register(slot); const command = `/login ${providerFor(slot)}`; const hasDraft = Boolean(ctx.ui.getEditorText().trim());
            if (!hasDraft) ctx.ui.setEditorText(command);
            ctx.ui.notify(`${hasDraft ? `Run ${command}` : "Press Enter"} to sign in, then reopen /accounts. Choose the intended account in your browser.`, "info"); return;
          }
          if (!ctx.isIdle()) throw new Error("A response started while the picker was open. Try /accounts when it finishes.");
          if (typeof chosen !== "string" && "logoutProvider" in chosen) {
            const logoutProvider = chosen.logoutProvider;
            const selected = found.find(account => account.provider === logoutProvider);
            const current = (await discover(ctx)).accounts.find(account => account.provider === logoutProvider);
            if (!ctx.isIdle()) throw new Error("A response started while the picker was open. Try /accounts when it finishes.");
            if (!selected || !current || current.accountId !== selected.accountId || current.label !== selected.label) {
              throw new Error("Account changed while the picker was open. Reopen /accounts.");
            }
            if (selected.kind === "claude") {
              ctx.ui.notify("Run `claude auth logout` in a terminal to sign out of Claude Code.", "info"); return;
            }
            const command = "/logout";
            const hasDraft = Boolean(ctx.ui.getEditorText().trim());
            if (!hasDraft) ctx.ui.setEditorText(command);
            const accountName = selected.provider === NATIVE ? "OpenAI Codex" : `OpenAI Codex · Account ${selected.slot}`;
            ctx.ui.notify(`${hasDraft ? `Run ${command} manually` : "Press Enter"}, then choose ${accountName}.`, "info"); return;
          }
          const makeDefault = typeof chosen !== "string" && "defaultProvider" in chosen;
          const provider = typeof chosen === "string" ? chosen : "defaultProvider" in chosen ? chosen.defaultProvider : chosen.provider;
          const selected = found.find(account => account.provider === provider)!;
          const current = (await discover(ctx)).accounts.find(account => account.provider === provider);
          if (!ctx.isIdle()) throw new Error("A response started while the picker was open. Try /accounts when it finishes.");
          if (!current || current.accountId !== selected.accountId || current.label !== selected.label) throw new Error("Account changed while the picker was open. Reopen /accounts.");
          if (!makeDefault && provider === ctx.model?.provider) return;
          let target;
          if (selected.kind === "codex" && kindOf(ctx.model?.provider) === "codex") target = switchTarget(ctx.model, provider, ctx.modelRegistry.getAvailable(), makeDefault ? [] : ctx.scopedModels);
          else if (selected.kind === "claude" && provider === ctx.model?.provider) target = ctx.model;
          else {
            target = lastModel(ctx.sessionManager.getBranch(), provider, ctx.modelRegistry.getAvailable(), ctx.scopedModels);
            if (!target) {
              chosen = await pickModel(ctx, provider, makeDefault);
              if (!chosen) continue;
              if (!ctx.isIdle()) throw new Error("A response started while the model picker was open. Try /accounts when it finishes.");
              const latest = (await discover(ctx)).accounts.find(account => account.provider === provider);
              if (!ctx.isIdle()) throw new Error("A response started while the model picker was open. Try /accounts when it finishes.");
              if (!latest || latest.accountId !== selected.accountId || latest.label !== selected.label) {
                throw new Error("Account changed while the model picker was open. Reopen /accounts.");
              }
              const modelId = typeof chosen === "string" || !("model" in chosen) ? undefined : chosen.model;
              target = availableFor(ctx, provider).find(model => model.id === modelId);
              if (!target) throw new Error("The selected model is no longer available or is outside the model scope.");
            }
          }
          if (makeDefault) {
            settings.setDefaultModelAndProvider(target.provider, target.id); await settings.flush();
            if (settings.drainErrors().length) throw new Error("Could not save Pi's default account. Check settings.json permissions and syntax.");
            ctx.ui.notify(`${selected.kind === "codex" ? `Account ${selected.slot}` : "Claude"} is now the default for new sessions (${target.id}). Existing sessions are unchanged.`, "info"); return;
          }
          if (!await pi.setModel(target)) throw new Error(`Could not switch accounts. ${selected.kind === "codex" ? "Sign in again with /login." : "Run Claude Code to sign in again."}`);
          status(ctx); ctx.ui.notify(`Using ${selected.label} (${target.id}).`, "info"); return;
        }
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Could not open accounts.", "error"); }
    },
  });
}
