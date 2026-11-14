import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RESUME_BUFFER_MS, RESUME_JITTER_MS, readAutoResume, resumeAt, writeAutoResume } from "../src/resume.ts";

const usage = (...windows: [label: "5h" | "week", remaining: number, reset: number][]) =>
  ({ windows: windows.map(([label, remaining, reset]) => ({ label, remaining, reset })) });

test("resume waits for the latest exhausted window plus buffer and jitter", () => {
  assert.equal(resumeAt(undefined, 1000, () => 0), undefined);
  assert.equal(resumeAt(usage(["5h", 0.5, 5000], ["week", 40, 9000]), 1000, () => 0), undefined);
  assert.equal(resumeAt(usage(["5h", 0, 5000], ["week", 40, 9000]), 1000, () => 0), 5000 + RESUME_BUFFER_MS);
  assert.equal(resumeAt(usage(["5h", 0, 5000], ["week", 0, 9000]), 1000, () => 0.5), 9000 + RESUME_BUFFER_MS + RESUME_JITTER_MS / 2);
  // A reset that already passed resumes from now rather than in the past.
  assert.equal(resumeAt(usage(["5h", 0, 500]), 1000, () => 0), 1000 + RESUME_BUFFER_MS);
});

test("auto-resume config is off unless saved on, and round-trips", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readAutoResume(dir), false);
  await mkdir(join(dir, "pi-accounts"));
  await writeFile(join(dir, "pi-accounts/config.json"), "{not json");
  assert.equal(await readAutoResume(dir), false);
  await writeFile(join(dir, "pi-accounts/config.json"), JSON.stringify({ autoResume: "yes" }));
  assert.equal(await readAutoResume(dir), false);
  await rm(join(dir, "pi-accounts"), { recursive: true });
  await writeAutoResume(dir, true);
  assert.equal(await readAutoResume(dir), true);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "pi-accounts/config.json"), "utf8")), { autoResume: true });
  await writeAutoResume(dir, false);
  assert.equal(await readAutoResume(dir), false);
});
