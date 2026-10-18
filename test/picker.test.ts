import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createModelPicker, createPicker, type PickerChoice } from "../src/picker.ts";
import { type Account, type Usage } from "../src/accounts.ts";

const accounts: Account[] = [
  { kind: "codex", slot: 1, provider: "openai-codex", label: "personal@example.com" },
  { kind: "codex", slot: 2, provider: "openai-codex-account-2", label: "另一个很长的账户@example.com" },
];
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("account actions target only selected accounts, not add or model rows", () => {
  let selected: PickerChoice | undefined;
  const picker = createPicker(accounts, accounts[0].provider, theme, () => {}, value => { selected = value; },
    () => new Promise(() => {}), accounts[1].provider);
  assert.match(picker.render(120).join("\n"), /default · Checking quota/);
  assert.match(picker.render(120).join("\n"), /l sign out/);
  picker.handleInput("d");
  assert.deepEqual(selected, { defaultProvider: accounts[0].provider });
  picker.dispose();

  selected = undefined;
  const add = createPicker([], undefined, theme, () => {}, value => { selected = value; }, () => new Promise(() => {}));
  assert.doesNotMatch(add.render(120).join("\n"), /sign out/);
  add.handleInput("d");
  add.handleInput("l");
  assert.equal(selected, undefined);
  add.dispose();

  const model = createModelPicker("claude-bridge", [{ id: "sonnet" }], false, theme, () => {}, value => { selected = value; });
  assert.doesNotMatch(model.render(120).join("\n"), /sign out/);
  model.handleInput("l");
  assert.equal(selected, undefined);
  model.dispose();
});

test("l signs out the highlighted account", () => {
  let selected: PickerChoice | undefined;
  const picker = createPicker(accounts, accounts[1].provider, theme, () => {}, value => { selected = value; }, () => new Promise(() => {}));
  picker.handleInput("l");
  assert.deepEqual(selected, { logoutProvider: accounts[1].provider });
  picker.dispose();
});

test("picker opens before quota resolves and remains width-safe", async () => {
  let finish!: (usage: Usage) => void;
  const picker = createPicker(accounts, accounts[0].provider, theme, () => {}, () => {}, () => new Promise(resolve => { finish = resolve; }));
  assert.match(picker.render(80).join("\n"), /Checking quota/);
  for (const width of [20, 40, 80, 120]) {
    assert.ok(picker.render(width).every(line => visibleWidth(line) <= width), `overflow at ${width}`);
  }
  finish({ windows: [{ label: "week", remaining: 64, reset: Date.now() + 60000 }] });
  await tick();
  assert.match(picker.render(120).join("\n"), /week 64% left/);
  picker.handleInput("\u001b[B");
  assert.match(picker.render(120).join("\n"), /\nweek 64% left · resets (\w{3} )?\d\d:\d\d \(in 1m\)/);
  picker.dispose();
});

test("Enter switches the highlighted account and Escape cancels all pending requests", async () => {
  let selected: PickerChoice | undefined;
  const signals: AbortSignal[] = [];
  const picker = createPicker(accounts, accounts[1].provider, theme, () => {}, value => { selected = value; }, (_account, signal) => {
    signals.push(signal);
    return new Promise(() => {});
  });
  picker.handleInput("\r");
  assert.equal(selected, accounts[1].provider);
  assert.ok(signals.every(signal => signal.aborted));
  picker.dispose();

  const cancel = createPicker(accounts, accounts[0].provider, theme, () => {}, value => { selected = value; }, async () => ({ windows: [] }));
  cancel.handleInput("\u001b");
  assert.equal(selected, undefined);
  cancel.dispose();
});

test("late quota results cannot repaint a closed picker", async () => {
  let renders = 0;
  let resolve!: (usage: Usage) => void;
  const picker = createPicker([accounts[0]], accounts[0].provider, theme, () => { renders++; }, () => {}, () => new Promise(done => { resolve = done; }));
  picker.dispose();
  resolve({ windows: [] });
  await tick();
  assert.equal(renders, 0);
});

test("model picker renders provider title and returns switch or default choices", () => {
  let choice: PickerChoice | undefined;
  const picker = createModelPicker("claude-bridge", [{ id: "sonnet" }], false, theme, () => {}, value => { choice = value; });
  assert.match(picker.render(80).join("\n"), /Claude models/);
  picker.handleInput("\r");
  assert.deepEqual(choice, { provider: "claude-bridge", model: "sonnet" });
  choice = undefined;
  const defaults = createModelPicker("claude-bridge", [{ id: "opus" }], true, theme, () => {}, value => { choice = value; });
  defaults.handleInput("\r");
  assert.deepEqual(choice, { defaultProvider: "claude-bridge", model: "opus" });
});

test("quota failure keeps accounts selectable and gives an actionable detail", async () => {
  let selected: PickerChoice | undefined;
  const picker = createPicker([accounts[0]], accounts[0].provider, theme, () => {}, value => { selected = value; }, async () => { throw new Error("Sign in again with /login."); });
  await tick();
  assert.match(picker.render(100).join("\n"), /Sign in again with \/login/);
  picker.handleInput("\r");
  assert.equal(selected, accounts[0].provider);
  picker.dispose();
});
