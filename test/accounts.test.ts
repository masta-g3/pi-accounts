import assert from "node:assert/strict";
import { test } from "node:test";
import { accountsFromAuth, providerFor, slotFor, parseUsage, usageText, switchTarget } from "../src/accounts.ts";

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
const credential = (email: string, accountId: string) => ({ type: "oauth", access: jwt({ email, "https://api.openai.com/auth": { chatgpt_account_id: accountId } }), refresh: "test", expires: 9999999999999 });

test("discovers only our OAuth accounts, sorts them, and keeps tokens out of UI data", () => {
  const accounts = accountsFromAuth({
    [providerFor(3)]: credential("second@example.com", "b"),
    "openai": credential("ignore@example.com", "c"),
    "openai-codex-2": credential("foreign@example.com", "d"),
    [providerFor(1)]: credential("first@example.com", "a"),
    [providerFor(2)]: { type: "api_key", key: "not-oauth" },
  });
  assert.deepEqual(accounts.map(a => [a.slot, a.label, a.accountId]), [[1, "first@example.com", "a"], [3, "second@example.com", "b"]]);
  assert.ok(!JSON.stringify(accounts).includes("refresh"));
  assert.equal(slotFor("openai-codex-account-0"), undefined);
  assert.equal(slotFor("openai-codex-account-02"), undefined);
  assert.equal(slotFor("openai-codex-account-1"), undefined);
});

test("account labels cannot inject terminal control sequences", () => {
  const [account] = accountsFromAuth({ [providerFor(1)]: credential("a\u001b[31m\n@example.com", "a") });
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(account.label));
  assert.ok(account.label.length <= 48);
});

test("malformed auth is reported rather than treated as no accounts", () => {
  assert.throws(() => accountsFromAuth([]), /auth.json/);
  const [account] = accountsFromAuth({ [providerFor(1)]: { type: "oauth", access: "invalid", refresh: "r", expires: 1 } });
  assert.equal(account.label, "Account 1");
  assert.equal(account.accountId, undefined);
});

const now = 1_800_000_000_000;
const window = (seconds: number, used: number, reset = now / 1000 + 3600) => ({ limit_window_seconds: seconds, used_percent: used, reset_at: reset });

test("five-hour and weekly quotas stay separately labeled", () => {
  const usage = parseUsage({ plan_type: "plus", rate_limit: { primary_window: window(18000, 100), secondary_window: window(604800, 36) } }, now);
  assert.equal(usage.tier, "plus");
  assert.equal(usageText(usage, now), "5h blocked · resets in 1h · week 64% left");
});

test("supports accounts with only a five-hour quota without inventing a weekly value", () => {
  const usage = parseUsage({ rate_limit: { primary_window: window(18000, 25) } }, now);
  assert.equal(usageText(usage, now), "5h 75% left");
  assert.throws(() => parseUsage({ rate_limit: { primary_window: window(18000, -5) } }, now), /quota/);
  assert.throws(() => parseUsage({ rate_limit: {} }, now), /quota/);
});

test("expired snapshots are not presented as current quota", () => {
  const usage = parseUsage({ rate_limit: { primary_window: window(18000, 100) } }, now);
  assert.equal(usageText(usage, now + 3600_000), "5h reset · reopen to refresh");
});

test("switch preserves the model, uses the registry, and obeys exact scope", () => {
  const model = { id: "gpt-test", provider: providerFor(1) };
  const target = { ...model, provider: providerFor(2), contextWindow: 1000 };
  assert.equal(switchTarget(model, providerFor(2), [target], []), target);
  assert.throws(() => switchTarget(model, providerFor(2), [target], [{ model }]), /scope/);
  assert.throws(() => switchTarget(model, providerFor(2), [], []), /available/);
  assert.throws(() => switchTarget({ ...model, provider: "anthropic" }, providerFor(2), [target], []), /Codex model/);
});
