import { getOperationalStore } from "../operational/provider.js";
import { deploymentOrg } from "../identity/binding.js";
import { loadGitHubAppConfig } from "./config.js";
import type { GitHubInstallationRow } from "../operational/store.js";

const HYDRATE_TTL_MS = 60_000;

let discovered: Record<string, string> = {};
let hydratedAt = 0;
let inFlight: Promise<void> | null = null;
let generation = 0;

export function composeGitHubInstallations(
  configured: Readonly<Record<string, string>>,
  discoveredMap: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...discoveredMap, ...configured };
}

export function discoveredGitHubInstallations(): Readonly<Record<string, string>> {
  return discovered;
}

export function discoveredInstallationsGeneration(): number {
  return generation;
}

export function resetGitHubInstallationsForTest(): void {
  discovered = {};
  hydratedAt = 0;
  inFlight = null;
  generation = 0;
}

function setDiscovered(next: Record<string, string>): void {
  const before = JSON.stringify(discovered);
  const after = JSON.stringify(next);
  discovered = next;
  if (before !== after) generation++;
}

export async function hydrateGitHubInstallations(org: string = deploymentOrg(), now: number = Date.now()): Promise<void> {
  if (now - hydratedAt < HYDRATE_TTL_MS) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const rows = await getOperationalStore().listGitHubInstallations(org);
      const next: Record<string, string> = {};
      for (const r of rows) next[r.owner] = r.installationId;
      setDiscovered(next);
      hydratedAt = now;
    } catch {
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export async function recordGitHubInstallation(rec: GitHubInstallationRow, org: string = deploymentOrg()): Promise<void> {
  await getOperationalStore().putGitHubInstallation(org, rec);
  setDiscovered({ ...discovered, [rec.owner]: rec.installationId });
}

export async function forgetGitHubInstallation(owner: string, org: string = deploymentOrg()): Promise<boolean> {
  const removed = await getOperationalStore().deleteGitHubInstallation(org, owner);
  if (owner in discovered) {
    const next = { ...discovered };
    delete next[owner];
    setDiscovered(next);
  }
  return removed;
}

export async function resolveGitHubInstallationId(
  owner: string,
  configured: Readonly<Record<string, string>> = loadGitHubAppConfig()?.installations ?? {},
  org: string = deploymentOrg(),
): Promise<string | undefined> {
  const fromEnv = configured[owner];
  if (fromEnv) return fromEnv;
  await hydrateGitHubInstallations(org);
  return composeGitHubInstallations(configured, discovered)[owner];
}
