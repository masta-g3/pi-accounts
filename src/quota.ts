import { type Account, parseClaudeUsage, parseUsage, tokenIdentity, type Usage } from "./accounts.ts";
import type { ClaudeCredential } from "./claude.ts";

export async function withDeadline<T>(parentSignal: AbortSignal, work: (signal: AbortSignal) => Promise<T>, timeout = 8000): Promise<T> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(timeout)]);
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([aborted, work(signal)]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function fetchCodexUsage(
  account: Account,
  resolveToken: (provider: string) => Promise<string | undefined>,
  parentSignal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Usage> {
  return withDeadline(parentSignal, async signal => {
    const access = await resolveToken(account.provider);
    signal.throwIfAborted();
    if (!access) throw new Error("Sign in again with /login.");
    const accountId = tokenIdentity(access).accountId;
    if (!accountId) throw new Error("Account identity unavailable. Sign in again.");
    if (account.accountId && accountId !== account.accountId) throw new Error("Account changed. Reopen /accounts.");
    const response = await request("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": accountId }, signal,
    });
    if (response.status === 401 || response.status === 403) throw new Error("Sign in again with /login.");
    if (!response.ok) throw new Error(`Quota unavailable (HTTP ${response.status}).`);
    return parseUsage(await response.json());
  });
}

export async function fetchClaudeUsage(
  readCredential: () => Promise<ClaudeCredential | undefined>,
  parentSignal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Usage> {
  return withDeadline(parentSignal, async signal => {
    const credential = await readCredential();
    signal.throwIfAborted();
    if (!credential) throw new Error("Claude login unavailable. Run Claude Code to sign in.");
    if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
      throw new Error("Claude login expired; it refreshes the next time Claude runs.");
    }
    const response = await request("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${credential.accessToken}`, "anthropic-beta": "oauth-2025-04-20" }, signal,
    });
    if (response.status === 401 || response.status === 403) throw new Error("Claude login expired; it refreshes the next time Claude runs.");
    if (!response.ok) throw new Error(`Quota unavailable (HTTP ${response.status}).`);
    return { ...parseClaudeUsage(await response.json()), tier: credential.subscriptionType };
  });
}
