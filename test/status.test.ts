import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { quotaStatus, type QuotaSnapshot, REFRESH_MS } from "../src/status.ts";
import { type Account, type Usage } from "../src/accounts.ts";

const now = 1_800_000_000_000;
const accounts: Account[] = [1, 2].map(slot => ({ kind: "codex", slot, provider: slot === 1 ? "openai-codex" : "openai-codex-account-2", label: `private${slot}@example.com`, accountId: String(slot) }));
const usage = (fiveHour: number, week: number): Usage => ({ windows: [
  { label: "5h", remaining: fiveHour, reset: now + 42 * 60000 },
  { label: "week", remaining: week, reset: now + 6 * 86400000 },
] });
const theme = { fg: (_color: string, text: string) => text };
const fresh = (value: Usage): QuotaSnapshot => ({ usage: value, fetchedAt: now, checkedAt: now });

test("each bar shows remaining quota and its reset countdown, with no window names or emails", () => {
  const result = quotaStatus(accounts, accounts[0].provider, account => fresh(account.slot === 1 ? usage(82, 64) : usage(35, 91)), theme, 100, now);
  assert.equal(result, "Codex ●1 ▰▰▰▰▱ 42m ▰▰▰▱▱ 6d · 2 ▰▰▱▱▱ 42m ▰▰▰▰▰ 6d");
  assert.ok(!result?.includes("@"));
  assert.ok(!/5h|week/.test(result!));
});

test("single-window accounts show one bar and do not change other accounts", () => {
  const readings = (account: Account) => fresh(account.slot === 1 ? { windows: [usage(0, 98).windows[1]] } : usage(40, 60));
  assert.equal(quotaStatus(accounts, accounts[0].provider, readings, theme, 100, now),
    "Codex ●1 ▰▰▰▰▰ 6d · 2 ▰▰▱▱▱ 42m ▰▰▰▱▱ 6d");
  assert.equal(quotaStatus(accounts, accounts[0].provider, readings, theme, 20, now), "Codex ●1 ▰▰▰▰▰ 6d +1");
  assert.equal(quotaStatus([accounts[0]], accounts[0].provider, () => fresh({ windows: [usage(80, 0).windows[0]] }), theme, 100, now),
    "Codex ●1 ▰▰▰▰▱ 42m");
});

test("color reflects each window independently; positive quota never looks empty", () => {
  const colors: string[] = [];
  const result = quotaStatus([accounts[0]], accounts[0].provider, () => fresh(usage(1, 80)), {
    fg: (color, text) => { colors.push(color); return text; },
  }, 100, now);
  assert.match(result!, /▰▱▱▱▱ 42m ▰▰▰▰▱ 6d/);
  assert.ok(colors.includes("warning"));
  assert.ok(!colors.includes("error"));
});

test("inactive accounts are dim, including their provider name and warning states", () => {
  for (const state of [fresh(usage(80, 60)), fresh(usage(1, 0)), { checkedAt: now, error: true }]) {
    const colors: string[] = [];
    quotaStatus([accounts[0]], "claude-bridge", () => state, {
      fg: (color, text) => { colors.push(color); return text; },
    }, 100, now);
    assert.ok(colors.length > 0);
    assert.ok(colors.every(color => color === "dim"), colors.join(", "));
  }
  const colors: string[] = [];
  quotaStatus([accounts[0]], accounts[0].provider, () => fresh(usage(80, 60)), {
    fg: (color, text) => { colors.push(color); return text; },
  }, 100, now);
  assert.ok(colors.includes("accent"));
  assert.ok(colors.includes("text"));
});

test("exhausted windows keep the red countdown and past resets show unknown", () => {
  assert.equal(quotaStatus(accounts, accounts[1].provider, account => fresh(account.slot === 1 ? usage(80, 60) : usage(0, 60)), theme, 100, now),
    "Codex 1 ▰▰▰▰▱ 42m ▰▰▰▱▱ 6d · ●2 ⏳42m ▰▰▰▱▱ 6d");
  assert.equal(quotaStatus([accounts[0]], accounts[0].provider, () => fresh(usage(80, 60)), theme, 100, now + 3 * 3600000 + 60000),
    "Codex ●1~ ????? ▰▰▰▱▱ 6d");
});

test("blocked windows show reset countdowns instead of empty bars", () => {
  const colors: string[] = [];
  const result = quotaStatus([accounts[0]], accounts[0].provider, () => fresh(usage(0, 0)), {
    fg: (color, text) => { colors.push(color); return text; },
  }, 100, now);
  assert.match(result!, /●1 ⏳42m ⏳6d/);
  assert.ok(colors.includes("error"));
});

test("unknown, expired, failed and stale readings cannot masquerade as fresh quota", () => {
  assert.match(quotaStatus([accounts[0]], accounts[0].provider, () => undefined, theme, 100, now)!, /●1 ·····$/);
  assert.match(quotaStatus([accounts[0]], accounts[0].provider, () => fresh(usage(80, 80)), theme, 100, now + REFRESH_MS)!, /●1~/);
  assert.match(quotaStatus([accounts[0]], accounts[0].provider, () => ({ ...fresh(usage(80, 80)), error: true }), theme, 100, now)!, /●1~/);
  assert.match(quotaStatus([accounts[0]], accounts[0].provider, () => fresh(usage(0, 80)), theme, 100, now + 43 * 60000)!, /\?\?\?\?\?/);
});

test("accounts without any quota reading show one warning icon", () => {
  const readings = (account: Account): QuotaSnapshot => account.slot === 1 ? fresh(usage(80, 60)) : { checkedAt: now, error: true };
  const colors: string[] = [];
  assert.equal(quotaStatus(accounts, accounts[0].provider, readings, {
    fg: (color, text) => { colors.push(color); return text; },
  }, 100, now), "Codex ●1 ▰▰▰▰▱ 42m ▰▰▰▱▱ 6d · 2 ⚠");
  assert.ok(!colors.includes("warning"));
  assert.equal(quotaStatus(accounts, accounts[1].provider, readings, theme, 100, now), "Codex 1 ▰▰▰▰▱ 42m ▰▰▰▱▱ 6d · ●2 ⚠");
  assert.equal(quotaStatus([accounts[1]], accounts[1].provider, readings, theme, 100, now), "Codex ●2 ⚠");
});

test("narrow panes keep the active account even when it is not first", () => {
  const render = (width: number) => quotaStatus(accounts, accounts[1].provider, () => fresh(usage(80, 60)), theme, width, now)!;
  assert.match(render(40), /●2/);
  assert.ok(!render(40).includes("●1"));
  assert.ok(!render(40).includes("│"));
  for (const width of [10, 20, 30, 40, 60, 100]) assert.ok(visibleWidth(render(width)) <= width);
  assert.match(quotaStatus(accounts, "anthropic", () => undefined, theme, 100, now)!, /Codex 1/);
});

test("groups Codex and Claude and marks only the active provider", () => {
  const claude: Account = { kind: "claude", slot: 1, provider: "claude-bridge", label: "private@example.com", accountId: "c" };
  assert.equal(quotaStatus([...accounts, claude], claude.provider, () => fresh(usage(80, 60)), theme, 120, now),
    "Codex 1 ▰▰▰▰▱ 42m ▰▰▰▱▱ 6d · 2 ▰▰▰▰▱ 42m ▰▰▰▱▱ 6d  │  Claude ●1 ▰▰▰▰▱ 42m ▰▰▰▱▱ 6d");
});
