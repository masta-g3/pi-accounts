import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchClaudeUsage, fetchCodexUsage } from "../src/quota.ts";
import { type Account } from "../src/accounts.ts";

const account: Account = { kind: "codex", slot: 1, provider: "openai-codex", label: "Personal", accountId: "a" };
const token = (accountId: string) => `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.x`;

test("quota requests use Pi-resolved auth, correct account, and abort signal", async () => {
  const controller = new AbortController();
  const usage = await fetchCodexUsage(account, async provider => {
    assert.equal(provider, account.provider);
    return token("a");
  }, controller.signal, async (url, options) => {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal((options?.headers as Record<string, string>)["ChatGPT-Account-Id"], "a");
    assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${token("a")}`);
    assert.ok(options?.signal);
    return Response.json({ rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 20, reset_after_seconds: 3600 } } });
  });
  assert.equal(usage.windows[0].remaining, 80);
});

test("account replacement is detected before sending a quota request", async () => {
  await assert.rejects(fetchCodexUsage(account, async () => token("b"), new AbortController().signal, async () => {
    assert.fail("must not fetch a different account under the old label");
  }), /Account changed/);
});

test("aborting the owner cancels quota work, including pending auth", async () => {
  const controller = new AbortController();
  const request = fetchCodexUsage(account, () => new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
});

test("HTTP auth failures surface without logging response bodies or credentials", async () => {
  await assert.rejects(fetchCodexUsage(account, async () => token("a"), new AbortController().signal, async () => new Response("secret", { status: 401 })), /Sign in again with \/login/);
});

test("Claude quota uses OAuth headers and maps remaining windows", async () => {
  const resets = new Date(Date.now() + 60000).toISOString();
  const usage = await fetchClaudeUsage(async () => ({ accessToken: "secret", subscriptionType: "max" }), new AbortController().signal,
    async (url, options) => {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.deepEqual(options?.headers, { Authorization: "Bearer secret", "anthropic-beta": "oauth-2025-04-20" });
      assert.ok(options?.signal);
      return Response.json({ five_hour: { utilization: 12, resets_at: resets }, seven_day: { utilization: 30, resets_at: resets } });
    });
  assert.deepEqual(usage.windows.map(window => [window.label, window.remaining]), [["5h", 88], ["week", 70]]);
  assert.equal(usage.tier, "max");
});

test("Claude expired credentials and HTTP auth failures use the login-expired message", async () => {
  let called = false;
  await assert.rejects(fetchClaudeUsage(async () => ({ accessToken: "secret", expiresAt: Date.now() - 1 }), new AbortController().signal,
    async () => { called = true; return Response.json({}); }), /Claude login expired/);
  assert.equal(called, false);
  await assert.rejects(fetchClaudeUsage(async () => ({ accessToken: "secret" }), new AbortController().signal,
    async () => new Response("secret", { status: 401 })), /Claude login expired/);
});
