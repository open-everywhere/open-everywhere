import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";
import { sanitizeFragment } from "./account-display-name.js";

export interface DirectoryCandidate {
  readonly nativeId: string;
  readonly name?: string;
  readonly handle?: string;
}

export type AccountDirectoryArm = (query: string, tenant?: string) => Promise<readonly DirectoryCandidate[]>;

const ARMS = processRegistryMap<AccountDirectoryArm>("account-directory.v1");

export function registerAccountDirectory(platform: string, arm: AccountDirectoryArm): void {
  if (!admitProviderRegistration(platform, "account-directory")) return;
  ARMS.set(platform, arm);
}

export function _resetAccountDirectoriesForTest(): void {
  ARMS.clear();
}

export function hasAccountDirectory(platform: string | undefined): boolean {
  return platform !== undefined && ARMS.has(platform);
}

export function accountDirectoryPlatforms(): readonly string[] {
  return [...ARMS.keys()];
}

export const DIRECTORY_MAX_CANDIDATES = 8;

let DIRECTORY_ARM_TIMEOUT_MS = 8000;

export function _setDirectoryArmTimeoutMsForTest(ms: number): void {
  DIRECTORY_ARM_TIMEOUT_MS = ms;
}

export function _resetDirectoryArmTimeoutMsForTest(): void {
  DIRECTORY_ARM_TIMEOUT_MS = 8000;
}

export interface DirectoryLookup {
  readonly candidates: readonly DirectoryCandidate[];
  readonly truncated: boolean;
}

export function rankDirectoryCandidates(rows: readonly DirectoryCandidate[], query: string, cap: number = DIRECTORY_MAX_CANDIDATES): DirectoryLookup {
  const q = normalizeQuery(query);
  if (q.length === 0) return { candidates: [], truncated: false };
  const scored: { row: DirectoryCandidate; score: number }[] = [];
  for (const row of rows) {
    const fields = [row.name, row.handle].filter((f): f is string => typeof f === "string" && f.length > 0).map(normalizeQuery);
    let score = -1;
    if (normalizeQuery(row.nativeId) === q) score = 3;
    else if (fields.some((f) => f === q)) score = 2;
    else if (fields.some((f) => f.startsWith(q))) score = 1;
    else if (fields.some((f) => f.includes(q))) score = 0;
    if (score >= 0) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return { candidates: scored.slice(0, cap).map((s) => s.row), truncated: scored.length > cap };
}

function normalizeQuery(raw: string): string {
  return raw.trim().replace(/^@/, "").replace(/\s+/gu, " ").toLowerCase();
}

export async function lookupAccountDirectory(platform: string, query: string, tenant?: string): Promise<DirectoryLookup> {
  const arm = ARMS.get(platform);
  if (!arm) return { candidates: [], truncated: false };
  const rows = await runArm(arm, query, tenant);
  return rankDirectoryCandidates(rows.map(sanitizeCandidate).filter((c): c is DirectoryCandidate => c !== undefined), query);
}

async function runArm(arm: AccountDirectoryArm, query: string, tenant: string | undefined): Promise<readonly DirectoryCandidate[]> {
  try {
    const timeout = new Promise<readonly DirectoryCandidate[]>((resolve) => {
      const t = setTimeout(() => resolve([]), DIRECTORY_ARM_TIMEOUT_MS);
      t.unref?.();
    });
    return (await Promise.race([arm(query, tenant), timeout])) ?? [];
  } catch {
    return [];
  }
}

function sanitizeCandidate(raw: DirectoryCandidate): DirectoryCandidate | undefined {
  const nativeId = typeof raw.nativeId === "string" ? raw.nativeId.trim() : "";
  if (nativeId.length === 0) return undefined;
  const name = typeof raw.name === "string" ? sanitizeFragment(raw.name) : "";
  const handle = typeof raw.handle === "string" ? sanitizeFragment(raw.handle) : "";
  return { nativeId, ...(name ? { name } : {}), ...(handle ? { handle } : {}) };
}
