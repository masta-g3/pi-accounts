import { type Account, parseUsage, tokenIdentity, type Usage } from "./accounts.ts";

export async function fetchUsage(
  account: Account,
  resolveToken: (provider: string) => Promise<string | undefined>,
  parentSignal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Usage> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(8000)]);
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, (async () => {
      const access = await resolveToken(account.provider);
      signal.throwIfAborted();
      if (!access) throw new Error("Sign in again with /login.");
      const accountId = tokenIdentity(access).accountId;
      if (!accountId) throw new Error("Account identity unavailable. Sign in again.");
      if (account.accountId && accountId !== account.accountId) throw new Error("Account changed. Reopen /codex.");
      const response = await request("https://chatgpt.com/backend-api/wham/usage", {
        headers: { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": accountId },
        signal,
      });
      if (response.status === 401 || response.status === 403) throw new Error("Sign in again with /login.");
      if (!response.ok) throw new Error(`Quota unavailable (HTTP ${response.status}).`);
      return parseUsage(await response.json());
    })()]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
