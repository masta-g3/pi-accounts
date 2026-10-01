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

function harness(t: TestContext) {
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
  let chosen: PickerChoice | undefined;
  let idle = true;
  let editor = "";
  const ctx = {
    cwd: dir, mode: "tui", isIdle: () => idle, model: { provider: providerFor(1), id: "gpt-test" }, scopedModels: [],
    modelRegistry: {
      getAvailable: () => [1, 2].map(slot => ({ provider: providerFor(slot), id: "gpt-test" })),
      getProviderAuth: async () => undefined,
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      custom: async () => chosen,
      notify: (text: string) => notifications.push(text),
      setStatus: (_key: string, text?: string) => statuses.push(text),
      getEditorText: () => editor,
      setEditorText: (value: string) => { editor = value; },
    },
  } as unknown as ExtensionCommandContext;
  codexAccounts({
    registerProvider: (provider: Provider) => providers.push(provider),
    registerCommand: (_name: string, config: { handler: typeof command }) => { command = config.handler; },
    on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
    setModel: async (model: Model<any>) => { switched.push(model); ctx.model = model; return true; },
  } as unknown as ExtensionAPI);
  handlers.get("session_start")?.({}, ctx);
  return {
    dir, auth, ctx, providers, notifications, statuses, switched, handlers,
    run: async (choice?: PickerChoice) => { chosen = choice; await command("", ctx); },
    busy: () => { idle = false; },
    getEditor: () => editor,
    setEditor: (value: string) => { editor = value; },
  };
}

test("command switches only on explicit choice and preserves model ID", async t => {
  const h = harness(t);
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

test("non-Codex models and non-TUI clients are not silently retargeted", async t => {
  const h = harness(t);
  h.ctx.model = { ...h.ctx.model!, provider: "anthropic" };
  await h.run(providerFor(2));
  assert.match(h.notifications.at(-1)!, /Codex model/);
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

test("background readings update bars, hide off Codex, and clean up on shutdown", async t => {
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
  assert.match(h.statuses.at(-1)!, /●1 ▰▰▰▰▱ ▰▰▰▱▱/);
  process.stdout.emit("resize");
  assert.equal(calls, 2);
  h.ctx.model = { ...h.ctx.model!, provider: "anthropic" };
  await h.handlers.get("model_select")?.({}, h.ctx);
  assert.equal(h.statuses.at(-1), undefined);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
  assert.equal(process.stdout.listenerCount("resize"), listeners);

  h.ctx.mode = "rpc";
  h.ctx.model = { ...h.ctx.model!, provider: providerFor(1) };
  await h.handlers.get("session_start")?.({}, h.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(process.stdout.listenerCount("resize"), listeners);
});
