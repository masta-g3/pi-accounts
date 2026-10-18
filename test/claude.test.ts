import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { claudeKeychainService, readClaudeAccount, readClaudeCredential, type ClaudeIo } from "../src/claude.ts";

const payload = { claudeAiOauth: { accessToken: "secret", expiresAt: 9999999999999, subscriptionType: "max" } };
const io = (overrides: Partial<ClaudeIo> = {}): ClaudeIo => ({
  platform: "linux", env: { HOME: "/home/test" }, readFile: async () => undefined,
  execSecurity: async () => undefined, ...overrides,
});

test("Claude keychain service follows Claude Code config naming", () => {
  assert.equal(claudeKeychainService({ HOME: "/home/test" }), "Claude Code-credentials");
  const env = { HOME: "/home/test", CLAUDE_CONFIG_DIR: "/tmp/Café" };
  const hash = createHash("sha256").update("/tmp/Café".normalize("NFC")).digest("hex").slice(0, 8);
  assert.equal(claudeKeychainService(env), `Claude Code-credentials-${hash}`);
});

test("reads Claude credentials from keychain then file fallback", async () => {
  const expected = { accessToken: "secret", expiresAt: 9999999999999, subscriptionType: "max" };
  assert.deepEqual(await readClaudeCredential(io({ platform: "darwin", execSecurity: async () => JSON.stringify(payload) })), expected);
  assert.deepEqual(await readClaudeCredential(io({ readFile: async path => path.endsWith(".credentials.json") ? JSON.stringify(payload) : undefined })), expected);
  assert.equal(await readClaudeCredential(io()), undefined);
  assert.equal(await readClaudeCredential(io({ readFile: async () => "not json" })), undefined);
});

test("reads Claude account identity and safe label", async () => {
  const account = await readClaudeAccount(io({ readFile: async path => path.endsWith(".credentials.json") ? JSON.stringify(payload)
    : JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", accountUuid: "uuid" } }) }));
  assert.deepEqual(account, { kind: "claude", slot: 1, provider: "claude-bridge", label: "me@example.com", accountId: "uuid" });
  const fallback = await readClaudeAccount(io({ readFile: async path => path.endsWith(".credentials.json") ? JSON.stringify(payload) : undefined }));
  assert.equal(fallback?.label, "Claude");
});
