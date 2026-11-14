import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "./accounts.ts";
import { atomicJson } from "./snapshot.ts";

export const RESUME_MESSAGE = "Continue where you left off. The usage limit has reset.";
export const RESUME_BUFFER_MS = 60000;
export const RESUME_JITTER_MS = 60000;
export const RESUME_MAX_ATTEMPTS = 3;

const configPath = (agentDir: string) => join(agentDir, "pi-accounts/config.json");

/** A missing or unreadable config means auto-resume is off. */
export async function readAutoResume(agentDir: string): Promise<boolean> {
  try { return JSON.parse(await readFile(configPath(agentDir), "utf8"))?.autoResume === true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false; throw error; }
}

export async function writeAutoResume(agentDir: string, on: boolean): Promise<void> {
  await mkdir(join(agentDir, "pi-accounts"), { recursive: true });
  await atomicJson(configPath(agentDir), { autoResume: on });
}

// Jitter spreads sessions that share one account so they do not all resume in the same second.
export function resumeAt(usage: Usage | undefined, now: number, random: () => number): number | undefined {
  const exhausted = usage?.windows.filter(window => window.remaining <= 0) ?? [];
  if (!exhausted.length) return undefined;
  return Math.max(now, ...exhausted.map(window => window.reset)) + RESUME_BUFFER_MS + Math.floor(random() * RESUME_JITTER_MS);
}
