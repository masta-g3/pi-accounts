import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { quotaStatus, type QuotaSnapshot, REFRESH_MS } from "../src/status.ts";
import { type Account, type Usage } from "../src/accounts.ts";

const now = 1_800_000_000_000;
const accounts: Account[] = [1, 2].map(slot => ({ slot, provider: slot === 1 ? "openai-codex" : "openai-codex-account-2", label: `private${slot}@example.com`, accountId: String(slot) }));
const usage = (fiveHour: number, week: number): Usage => ({ windows: [
  { label: "5h", remaining: fiveHour, reset: now + 42 * 60000 },
  { label: "week", remaining: week, reset: now + 6 * 86400000 },
] });
const theme = { fg: (_color: string, text: string) => text };
const fresh = (value: Usage): QuotaSnapshot => ({ usage: value, fetchedAt: now, checkedAt: now });

test("shows both remaining-quota bars in fixed order with one shared legend and no emails", () => {
  const result = quotaStatus(accounts, accounts[0].provider, account => fresh(account.slot === 1 ? usage(82, 64) : usage(35, 91)), theme, 100, now);
  assert.equal(result, "Codex · 5h / week  ●1 ▰▰▰▰▱ ▰▰▰▱▱  │  2 ▰▰▱▱▱ ▰▰▰▰▰");
  assert.ok(!result?.includes("@"));
});

test("weekly-only readings show a single bar and a matching legend", () => {
  const weekly: Usage = { windows: [usage(0, 98).windows[1]] };
  assert.equal(quotaStatus([accounts[0]], accounts[0].provider, () => fresh(weekly), theme, 100, now),
    "Codex · week  ●1 ▰▰▰▰▰");
});

test("mixed account limits label each bar rather than implying matching positions", () => {
  const readings = (account: Account) => fresh(account.slot === 1 ? { windows: [usage(0, 98).windows[1]] } : usage(40, 60));
  assert.equal(quotaStatus(accounts, accounts[0].provider, readings, theme, 100, now),
    "Codex  ●1 week ▰▰▰▰▰  │  2 5h ▰▰▱▱▱ week ▰▰▰▱▱");
  assert.equal(quotaStatus(accounts, accounts[0].provider, readings, theme, 30, now),
    "Codex · week  ●1 ▰▰▰▰▰ +1");
});

test("five-hour-only readings use the correct single-window legend", () => {
  const fiveHour: Usage = { windows: [usage(80, 0).windows[0]] };
  assert.equal(quotaStatus([accounts[0]], accounts[0].provider, () => fresh(fiveHour), theme, 100, now),
    "Codex · 5h  ●1 ▰▰▰▰▱");
});

test("color reflects each window independently; positive quota never looks empty", () => {
  const colors: string[] = [];
  const result = quotaStatus([accounts[0]], accounts[0].provider, () => fresh(usage(1, 80)), {
    fg: (color, text) => { colors.push(color); return text; },
  }, 100, now);
  assert.match(result!, /▰▱▱▱▱ ▰▰▰▰▱/);
  assert.ok(colors.includes("warning"));
  assert.ok(!colors.includes("error"));
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
  assert.match(quotaStatus([accounts[0]], accounts[0].provider, () => undefined, theme, 100, now)!, /●1 ····· ·····/);
  assert.match(quotaStatus([accounts[0]], accounts[0].provider, () => ({ checkedAt: now, error: true }), theme, 100, now)!, /●1 \?\?\?\?\? \?\?\?\?\?/);
  assert.match(quotaStatus([accounts[0]], accounts[0].provider, () => fresh(usage(80, 80)), theme, 100, now + REFRESH_MS)!, /●1~/);
  assert.match(quotaStatus([accounts[0]], accounts[0].provider, () => ({ ...fresh(usage(80, 80)), error: true }), theme, 100, now)!, /●1~/);
  assert.match(quotaStatus([accounts[0]], accounts[0].provider, () => fresh(usage(0, 80)), theme, 100, now + 43 * 60000)!, /\?\?\?\?\?/);
});

test("narrow panes keep the active account even when it is not first", () => {
  const render = (width: number) => quotaStatus(accounts, accounts[1].provider, () => fresh(usage(80, 60)), theme, width, now)!;
  assert.match(render(40), /●2/);
  assert.ok(!render(40).includes("●1"));
  assert.ok(!render(40).includes("│"));
  for (const width of [10, 20, 30, 40, 60, 100]) assert.ok(visibleWidth(render(width)) <= width);
  assert.equal(quotaStatus(accounts, "anthropic", () => undefined, theme, 100, now), undefined);
});
