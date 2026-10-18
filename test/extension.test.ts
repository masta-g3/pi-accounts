import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model, Provider } from "@earendil-works/pi-ai";
import codexAccounts from "../src/index.ts";
import { ADD_ACCOUNT, type PickerChoice } from "../src/picker.ts";
import { providerFor } from "../src/accounts.ts";
import { CLAUDE } from "../src/claude.ts";

type HarnessOptions = {
  claude?: boolean;
  claudeModels?: string[];
  branch?: unknown[];
  readClaudeAccount?: () => Promise<any>;
  readClaudeCredential?: () => Promise<any>;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  onCustom?: (index: number, ctx: ExtensionCommandContext, setIdle: (value: boolean) => void) => void;
};

function harness(t: TestContext, options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-codex-accounts-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const auth = Object.fromEntries([1, 2].map(slot => [providerFor(slot), {
    type: "oauth", access: `x.${Buffer.from(JSON.stringify({ email: `account${slot}@example.com` })).toString("base64url")}.x`,
    accountId: String(slot), refresh: "test", expires: Date.now() + 60000,
  }]));
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  const providers: Provider[] = [];
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  const switched: Model<any>[] = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let commandName = "";
  let choices: (PickerChoice | undefined)[] = [];
  let idle = true;
  let customCount = 0;
  let editor = "";
  const ctx = {
    cwd: dir, mode: "tui", isIdle: () => idle, model: { provider: providerFor(1), id: "gpt-test" }, scopedModels: [],
    modelRegistry: {
      getAvailable: () => [...[1, 2].map(slot => ({ provider: providerFor(slot), id: "gpt-test" })),
        ...(options.claude ? (options.claudeModels ?? ["claude-test"]).map(id => ({ provider: CLAUDE, id })) : [])],
      getProviderAuth: async () => undefined,
    },
    sessionManager: { getBranch: () => options.branch ?? [] },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      custom: async () => {
        const choice = choices.shift();
        options.onCustom?.(customCount++, ctx, value => { idle = value; });
        return choice;
      },
      notify: (text: string) => notifications.push(text),
      setStatus: (_key: string, text?: string) => statuses.push(text),
      getEditorText: () => editor,
      setEditorText: (value: string) => { editor = value; },
    },
  } as unknown as ExtensionCommandContext;
  codexAccounts({
    registerProvider: (provider: Provider) => providers.push(provider),
    registerCommand: (name: string, config: { handler: typeof command }) => { commandName = name; command = config.handler; },
    on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
    setModel: async (model: Model<any>) => { switched.push(model); ctx.model = model; return true; },
  } as unknown as ExtensionAPI, options.claude ? {
    readClaudeAccount: options.readClaudeAccount ?? (async () => ({ kind: "claude", slot: 1, provider: CLAUDE, label: "Claude", accountId: "claude-id" })),
    readClaudeCredential: options.readClaudeCredential ?? (async () => undefined),
    now: options.now ?? Date.now,
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
  } : undefined);
  handlers.get("session_start")?.({}, ctx);
  return {
    dir, auth, ctx, providers, notifications, statuses, switched, handlers, commandName,
    run: async (...next: (PickerChoice | undefined)[]) => { choices = next; await command("", ctx); },
    busy: () => { idle = false; },
    idle: () => { idle = true; },
    getEditor: () => editor,
    setEditor: (value: string) => { editor = value; },
  };
}

test("command switches only on explicit choice and preserves model ID", async t => {
  const h = harness(t);
  assert.equal(h.commandName, "accounts");
  await h.handlers.get("session_start")?.({}, h.ctx);
  assert.equal(h.switched.length, 0);
  assert.equal(h.providers.length, 1);
  await h.run();
  assert.equal(h.switched.length, 0);
  await h.run(providerFor(2));
  assert.deepEqual(h.switched.map(model => [model.provider, model.id]), [[providerFor(2), "gpt-test"]]);
  assert.match(h.statuses.at(-1)!, /●2/);
  assert.ok(!h.statuses.at(-1)!.includes("@"));
  await h.run(providerFor(2));
  assert.equal(h.switched.length, 1);
});

test("cross-provider switching uses branch history or a picked model", async t => {
  const fromHistory = harness(t, { claude: true, branch: [{ type: "model_change", provider: CLAUDE, modelId: "claude-test" }] });
  await fromHistory.run(CLAUDE);
  assert.deepEqual(fromHistory.switched.at(-1), { provider: CLAUDE, id: "claude-test" });

  const picked = harness(t, { claude: true });
  await picked.run(CLAUDE, { provider: CLAUDE, model: "claude-test" });
  assert.deepEqual(picked.switched.at(-1), { provider: CLAUDE, id: "claude-test" });
  picked.ctx.model = { provider: CLAUDE, id: "claude-test" } as Model<any>;
  await picked.run(providerFor(1), { provider: providerFor(1), model: "gpt-test" });
  assert.deepEqual(picked.switched.at(-1), { provider: providerFor(1), id: "gpt-test" });

  const scoped = harness(t, {
    claude: true, claudeModels: ["claude-old", "claude-test"],
    branch: [{ type: "model_change", provider: CLAUDE, modelId: "claude-old" }],
  });
  scoped.ctx.scopedModels = [{ model: { provider: CLAUDE, id: "claude-test" } as Model<any> }];
  await scoped.run(CLAUDE, { provider: CLAUDE, model: "claude-test" });
  assert.deepEqual(scoped.switched.at(-1), { provider: CLAUDE, id: "claude-test" });
});

test("Codex switch stops when a response starts during account revalidation", async t => {
  let reads = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const h = harness(t, {
    claude: true,
    readClaudeAccount: async () => {
      if (++reads === 3) await blocked;
      return { kind: "claude", slot: 1, provider: CLAUDE, label: "Claude", accountId: "claude-id" };
    },
  });
  const running = h.run(providerFor(2));
  while (reads < 3) await new Promise(resolve => setImmediate(resolve));
  h.busy();
  release();
  await running;
  assert.equal(h.switched.length, 0);
  assert.match(h.notifications.at(-1)!, /response started/);
});

test("history-resolved switch stops when a response starts during account revalidation", async t => {
  let reads = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const h = harness(t, {
    claude: true,
    branch: [{ type: "model_change", provider: CLAUDE, modelId: "claude-test" }],
    readClaudeAccount: async () => {
      if (++reads === 3) await blocked;
      return { kind: "claude", slot: 1, provider: CLAUDE, label: "Claude", accountId: "claude-id" };
    },
  });
  const running = h.run(CLAUDE);
  while (reads < 3) await new Promise(resolve => setImmediate(resolve));
  h.busy();
  release();
  await running;
  assert.equal(h.switched.length, 0);
  assert.match(h.notifications.at(-1)!, /response started/);
});

test("default write stops when a response starts during account revalidation", async t => {
  let reads = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const h = harness(t, {
    claude: true,
    readClaudeAccount: async () => {
      if (++reads === 3) await blocked;
      return { kind: "claude", slot: 1, provider: CLAUDE, label: "Claude", accountId: "claude-id" };
    },
  });
  const path = join(h.dir, "settings.json");
  writeFileSync(path, JSON.stringify({ theme: "test-theme" }));
  const running = h.run({ defaultProvider: providerFor(2) });
  while (reads < 3) await new Promise(resolve => setImmediate(resolve));
  h.busy();
  release();
  await running;
  const { readFileSync } = await import("node:fs");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { theme: "test-theme" });
  assert.match(h.notifications.at(-1)!, /response started/);
});

test("model picker revalidates idle state and model scope before switching", async t => {
  const busy = harness(t, { claude: true, onCustom: (index, _ctx, setIdle) => { if (index === 1) setIdle(false); } });
  await busy.run(CLAUDE, { provider: CLAUDE, model: "claude-test" });
  assert.equal(busy.switched.length, 0);
  assert.match(busy.notifications.at(-1)!, /model picker/);

  const scoped = harness(t, { claude: true, onCustom: (index, ctx) => {
    if (index === 1) ctx.scopedModels = [{ model: { provider: providerFor(1), id: "gpt-test" } as Model<any> }];
  } });
  await scoped.run(CLAUDE, { provider: CLAUDE, model: "claude-test" });
  assert.equal(scoped.switched.length, 0);
  assert.match(scoped.notifications.at(-1)!, /scope/);
});

test("model picker revalidates account identity before switching", async t => {
  let accountId = "claude-id";
  const h = harness(t, {
    claude: true,
    readClaudeAccount: async () => ({ kind: "claude", slot: 1, provider: CLAUDE, label: "Claude", accountId }),
    onCustom: index => { if (index === 1) accountId = "replacement"; },
  });
  await h.run(CLAUDE, { provider: CLAUDE, model: "claude-test" });
  assert.equal(h.switched.length, 0);
  assert.match(h.notifications.at(-1)!, /Account changed while the model picker/);
});

test("cross-provider default resolves a model without switching", async t => {
  const h = harness(t, { claude: true });
  await h.run({ defaultProvider: CLAUDE }, { defaultProvider: CLAUDE, model: "claude-test" });
  const { readFileSync } = await import("node:fs");
  const saved = JSON.parse(readFileSync(join(h.dir, "settings.json"), "utf8"));
  assert.equal(saved.defaultProvider, CLAUDE);
  assert.equal(saved.defaultModel, "claude-test");
  assert.equal(h.switched.length, 0);
});

test("making an account default persists Pi defaults without switching this session", async t => {
  const h = harness(t);
  const path = join(h.dir, "settings.json");
  writeFileSync(path, JSON.stringify({ theme: "test-theme", packages: ["test-package"] }));
  await h.run({ defaultProvider: providerFor(2) });
  const { readFileSync } = await import("node:fs");
  const beforeSwitch = readFileSync(path, "utf8");
  const saved = JSON.parse(beforeSwitch);
  assert.equal(saved.defaultProvider, providerFor(2));
  assert.equal(saved.defaultModel, "gpt-test");
  assert.equal(saved.theme, "test-theme");
  assert.deepEqual(saved.packages, ["test-package"]);
  assert.equal(h.ctx.model?.provider, providerFor(1));
  assert.equal(h.switched.length, 0);
  await h.run(providerFor(2));
  assert.equal(readFileSync(path, "utf8"), beforeSwitch);
});

test("invalid settings are preserved and default selection does not claim success", async t => {
  const h = harness(t);
  const path = join(h.dir, "settings.json");
  writeFileSync(path, "{invalid");
  await h.run({ defaultProvider: providerFor(2) });
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(path, "utf8"), "{invalid");
  assert.match(h.notifications.at(-1)!, /Could not save/);
  assert.equal(h.switched.length, 0);
});

test("busy and scoped sessions cannot switch through the picker", async t => {
  const h = harness(t);
  h.ctx.scopedModels = [{ model: h.ctx.model! }] as ExtensionCommandContext["scopedModels"];
  await h.run(providerFor(2));
  assert.equal(h.switched.length, 0);
  assert.match(h.notifications.at(-1)!, /scope/);
  h.busy();
  await h.run(providerFor(2));
  assert.equal(h.switched.length, 0);
  assert.match(h.notifications.at(-1)!, /finish/);
});

test("add reuses an unsigned provider and never writes auth or replaces a draft", async t => {
  const h = harness(t);
  await h.run(ADD_ACCOUNT);
  assert.equal(h.getEditor(), "/login openai-codex-account-3");
  assert.equal(h.providers.length, 2);
  h.setEditor("my draft");
  await h.run(ADD_ACCOUNT);
  assert.equal(h.getEditor(), "my draft");
  assert.equal(h.providers.length, 2);
  const { readFileSync } = await import("node:fs");
  assert.deepEqual(JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8")), h.auth);
});

test("Codex sign out prepares native Pi logout without changing credentials or defaults", async t => {
  const h = harness(t);
  const { readFileSync } = await import("node:fs");
  const settingsPath = join(h.dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultProvider: providerFor(2), defaultModel: "gpt-test" }));
  h.ctx.model = undefined;

  await h.run({ logoutProvider: providerFor(1) });
  assert.equal(h.getEditor(), "/logout");
  assert.match(h.notifications.at(-1)!, /Press Enter, then choose OpenAI Codex\./);
  assert.deepEqual(JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8")), h.auth);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { defaultProvider: providerFor(2), defaultModel: "gpt-test" });

  h.setEditor("");
  await h.run({ logoutProvider: providerFor(2) });
  assert.equal(h.getEditor(), "/logout");
  assert.match(h.notifications.at(-1)!, /OpenAI Codex · Account 2/);
});

test("sign out preserves drafts, gives Claude terminal-only instructions, and obeys the busy guard", async t => {
  const codex = harness(t);
  codex.setEditor("keep this draft");
  await codex.run({ logoutProvider: providerFor(2) });
  assert.equal(codex.getEditor(), "keep this draft");
  assert.match(codex.notifications.at(-1)!, /Run \/logout manually.*OpenAI Codex · Account 2/);

  const claude = harness(t, { claude: true });
  claude.setEditor("keep Claude draft");
  await claude.run({ logoutProvider: CLAUDE });
  assert.equal(claude.getEditor(), "keep Claude draft");
  assert.equal(claude.notifications.at(-1), "Run `claude auth logout` in a terminal to sign out of Claude Code.");

  const busy = harness(t, { onCustom: (_index, _ctx, setIdle) => setIdle(false) });
  await busy.run({ logoutProvider: providerFor(1) });
  assert.equal(busy.getEditor(), "");
  assert.match(busy.notifications.at(-1)!, /response started/);
});

test("non-Codex models and non-TUI clients are not silently retargeted", async t => {
  const h = harness(t);
  h.ctx.model = { ...h.ctx.model!, provider: "anthropic" };
  await h.run(providerFor(2));
  assert.equal(h.switched.length, 0);
  h.ctx.mode = "rpc";
  await h.run(providerFor(2));
  assert.match(h.notifications.at(-1)!, /terminal UI/);
});

test("corrupt auth reports the problem without exposing credential fragments", async t => {
  const h = harness(t);
  writeFileSync(join(h.dir, "auth.json"), '{"access":"secret-token",broken');
  await h.run(providerFor(2));
  assert.match(h.notifications.at(-1)!, /invalid JSON/);
  assert.ok(!h.notifications.at(-1)!.includes("secret-token"));
  assert.equal(h.switched.length, 0);
});

test("Claude account appears only when bridge models and credentials are both available", async t => {
  const missingCredential = harness(t, { claude: true, readClaudeAccount: async () => undefined });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!missingCredential.statuses.at(-1)?.includes("Claude"));

  const noBridge = harness(t);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!noBridge.statuses.at(-1)?.includes("Claude"));

  const found = harness(t, { claude: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(found.statuses.at(-1)!, /Claude/);
});

test("Claude discovery failure keeps Codex accounts and reports the isolated error", async t => {
  const h = harness(t, { claude: true, readClaudeAccount: async () => { throw new Error("credential file unreadable"); } });
  await new Promise(resolve => setImmediate(resolve));
  const status = h.statuses.at(-1)!;
  assert.match(status, /Codex/);
  assert.match(status, /●1/);
  assert.match(status, /Claude unavailable/);
  assert.ok(!status.includes("auth.json"));
});

test("Claude response refresh is deferred, coalesced, and cleared on shutdown", async t => {
  let now = 1000;
  let credentialReads = 0;
  const scheduled: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const fakeSetTimeout = ((callback: () => void, delay?: number) => {
    const item = { callback, delay: delay ?? 0, cleared: false };
    scheduled.push(item);
    return { unref() {} } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const fakeClearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const index = scheduled.findIndex(item => (item as any).handle === handle);
    if (index >= 0) scheduled[index].cleared = true;
  }) as typeof clearTimeout;
  // Associate handles after creation without relying on Node timer internals.
  const handles: ReturnType<typeof setTimeout>[] = [];
  const trackedSetTimeout = ((callback: () => void, delay?: number) => {
    const handle = fakeSetTimeout(callback, delay);
    handles.push(handle);
    (scheduled.at(-1) as any).handle = handle;
    return handle;
  }) as typeof setTimeout;
  const h = harness(t, {
    claude: true, now: () => now, setTimeout: trackedSetTimeout, clearTimeout: fakeClearTimeout,
    readClaudeCredential: async () => { credentialReads++; return undefined; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(credentialReads, 1);
  h.ctx.model = { provider: CLAUDE, id: "claude-test" } as Model<any>;
  h.handlers.get("after_provider_response")?.({}, h.ctx);
  h.handlers.get("after_provider_response")?.({}, h.ctx);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 60000);
  now = 61000;
  scheduled[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(credentialReads, 2);
  h.handlers.get("after_provider_response")?.({}, h.ctx);
  assert.equal(scheduled.length, 2);
  h.handlers.get("session_shutdown")?.({}, h.ctx);
  assert.equal(scheduled[1].cleared, true);
});

test("late and overlapping discovery cannot overwrite newer lifecycle state", async t => {
  const resolvers: ((account: any) => void)[] = [];
  const h = harness(t, { claude: true, readClaudeAccount: () => new Promise(resolve => { resolvers.push(resolve); }) });
  h.handlers.get("model_select")?.({}, h.ctx);
  h.handlers.get("model_select")?.({}, h.ctx);
  assert.equal(resolvers.length, 3);
  resolvers[2]({ kind: "claude", slot: 1, provider: CLAUDE, label: "Claude", accountId: "current" });
  await new Promise(resolve => setImmediate(resolve));
  const current = h.statuses.at(-1);
  assert.match(current!, /Claude/);
  resolvers[1](undefined);
  resolvers[0](undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.statuses.at(-1), current);
  h.handlers.get("model_select")?.({}, h.ctx);
  assert.equal(resolvers.length, 4);
  h.handlers.get("session_shutdown")?.({}, h.ctx);
  const stoppedAt = h.statuses.length;
  resolvers[3]({ kind: "claude", slot: 1, provider: CLAUDE, label: "Late", accountId: "late" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.statuses.length, stoppedAt);
  assert.equal(h.statuses.at(-1), undefined);
});

test("background readings update bars, stay visible off Codex, and clean up on shutdown", async t => {
  const listeners = process.stdout.listenerCount("resize");
  const h = harness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ rate_limit: {
      primary_window: { limit_window_seconds: 18000, used_percent: 20, reset_after_seconds: 3600 },
      secondary_window: { limit_window_seconds: 604800, used_percent: 40, reset_after_seconds: 86400 },
    } });
  });
  h.ctx.modelRegistry.getProviderAuth = async provider => ({ auth: { apiKey: `x.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: provider === providerFor(1) ? "1" : "2" },
  })).toString("base64url")}.x` } });
  await h.handlers.get("session_start")?.({}, h.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.match(h.statuses.at(-1)!, /●1 ▰▰▰▰▱ 1h ▰▰▰▱▱ 1d/);
  process.stdout.emit("resize");
  assert.equal(calls, 2);
  h.ctx.model = { ...h.ctx.model!, provider: "anthropic" };
  await h.handlers.get("model_select")?.({}, h.ctx);
  assert.match(h.statuses.at(-1)!, /Codex 1/);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
  assert.equal(process.stdout.listenerCount("resize"), listeners);

  h.ctx.mode = "rpc";
  h.ctx.model = { ...h.ctx.model!, provider: providerFor(1) };
  await h.handlers.get("session_start")?.({}, h.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(process.stdout.listenerCount("resize"), listeners);
});
