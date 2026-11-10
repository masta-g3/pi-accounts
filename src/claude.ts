import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Account } from "./accounts.ts";
import { cleanLabel } from "./accounts.ts";

// pi-claude-code first; pi-claude-bridge remains supported. Both share Claude Code's single login.
export const CLAUDE_PROVIDERS = ["claude-code", "claude-bridge"] as const;
export const CLAUDE = CLAUDE_PROVIDERS[0];
export const isClaude = (provider: string | undefined) => (CLAUDE_PROVIDERS as readonly (string | undefined)[]).includes(provider);
export type ClaudeCredential = { accessToken: string; expiresAt?: number; subscriptionType?: string };
export type ClaudeIo = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  readFile(path: string): Promise<string | undefined>;
  execSecurity(service: string): Promise<string | undefined>;
};
const exec = promisify(execFile);
const defaultIo: ClaudeIo = {
  platform: process.platform,
  env: process.env,
  async readFile(path) {
    try { return await (await import("node:fs/promises")).readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  },
  async execSecurity(service) {
    try {
      const { stdout } = await exec("security", ["find-generic-password", "-a", process.env.USER ?? "", "-w", "-s", service], { timeout: 2000 });
      return stdout;
    } catch { return undefined; }
  },
};

// pi-claude-code passes PI_CLAUDE_CODE_CONFIG_DIR to Claude Code as CLAUDE_CONFIG_DIR.
const configOverride = (env: NodeJS.ProcessEnv) => env.PI_CLAUDE_CODE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR;
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return (configOverride(env) || join(env.HOME || homedir(), ".claude")).normalize("NFC");
}
export function claudeKeychainService(env: NodeJS.ProcessEnv = process.env): string {
  return configOverride(env) ? `Claude Code-credentials-${createHash("sha256").update(claudeConfigDir(env)).digest("hex").slice(0, 8)}`
    : "Claude Code-credentials";
}
function credential(text: string | undefined): ClaudeCredential | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text)?.claudeAiOauth;
    return value && typeof value.accessToken === "string" ? {
      accessToken: value.accessToken,
      ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
      ...(typeof value.subscriptionType === "string" ? { subscriptionType: cleanLabel(value.subscriptionType) } : {}),
    } : undefined;
  } catch { return undefined; }
}
export async function readClaudeCredential(io: ClaudeIo = defaultIo): Promise<ClaudeCredential | undefined> {
  if (io.platform === "darwin") {
    const fromKeychain = credential(await io.execSecurity(claudeKeychainService(io.env)));
    if (fromKeychain) return fromKeychain;
  }
  return credential(await io.readFile(join(claudeConfigDir(io.env), ".credentials.json")));
}
export async function readClaudeAccount(io: ClaudeIo = defaultIo): Promise<Account | undefined> {
  if (!await readClaudeCredential(io)) return undefined;
  let identity: any;
  const identityDir = configOverride(io.env) || io.env.HOME || homedir();
  try { identity = JSON.parse(await io.readFile(join(identityDir, ".claude.json")) ?? "null")?.oauthAccount; } catch {}
  return { kind: "claude", slot: 1, provider: CLAUDE,
    label: typeof identity?.emailAddress === "string" ? cleanLabel(identity.emailAddress) || "Claude" : "Claude",
    ...(typeof identity?.accountUuid === "string" ? { accountId: identity.accountUuid } : {}),
  };
}
