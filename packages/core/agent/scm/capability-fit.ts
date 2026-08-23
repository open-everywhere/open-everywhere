import { REPO_CAPABILITIES, type RepoCapability } from "../access/repo-capabilities.js";
import { REPO_CAPABILITY_PERMISSIONS } from "./mint.js";

export interface CapabilityShortfall {
  readonly capability: RepoCapability;
  readonly family: string;
  readonly need: string;
  readonly granted?: string;
}

export interface CapabilityFit {
  readonly ok: boolean;
  readonly reported: boolean;
  readonly missing: readonly CapabilityShortfall[];
}

function covers(granted: string | undefined, need: string): boolean {
  if (granted === undefined) return false;
  return granted === "write" || granted === need;
}

export function capabilityInstallationFit(
  capabilities: readonly RepoCapability[],
  granted: Readonly<Record<string, string>> | undefined,
): CapabilityFit {
  if (granted === undefined) return { ok: true, reported: false, missing: [] };
  const missing: CapabilityShortfall[] = [];
  for (const capability of capabilities) {
    const families = REPO_CAPABILITY_PERMISSIONS[capability];
    if (!families) continue;
    for (const [family, need] of Object.entries(families)) {
      const has = Object.hasOwn(granted, family) ? granted[family] : undefined;
      if (!covers(has, need)) missing.push({ capability, family, need, ...(has === undefined ? {} : { granted: has }) });
    }
  }
  return { ok: missing.length === 0, reported: true, missing };
}

export function installationApprovalUrls(owner: string, installationId: string): readonly string[] {
  return [
    `https://github.com/organizations/${owner}/settings/installations/${installationId}`,
    `https://github.com/settings/installations/${installationId}`,
  ];
}

export function repoOwner(repo: string): string {
  const slash = repo.indexOf("/");
  return slash > 0 ? repo.slice(0, slash) : "";
}

export interface RepoCapabilityRow {
  readonly repo: string;
  readonly capability: RepoCapability;
  readonly declared: boolean;
  readonly fit: CapabilityFit;
}

export function repoCapabilityRows(
  repos: readonly string[],
  declared: Readonly<Record<string, readonly RepoCapability[]>>,
  grantedByOwner: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
): readonly RepoCapabilityRow[] {
  const rows: RepoCapabilityRow[] = [];
  for (const repo of [...repos].sort()) {
    const owner = repoOwner(repo);
    const granted = Object.hasOwn(grantedByOwner, owner) ? grantedByOwner[owner] : undefined;
    const here = new Set(declared[repo] ?? []);
    for (const capability of Object.keys(REPO_CAPABILITIES).sort() as RepoCapability[]) {
      rows.push({ repo, capability, declared: here.has(capability), fit: capabilityInstallationFit([capability], granted) });
    }
  }
  return rows;
}

export function renderRepoCapabilityRows(
  rows: readonly RepoCapabilityRow[],
  installationIdByOwner: Readonly<Record<string, string | undefined>> = {},
): string[] {
  if (rows.length === 0) return ["No GitHub repos are granted to this domain, so there is nothing to expand."];
  const lines: string[] = [];
  let repo = "";
  for (const row of rows) {
    if (row.repo !== repo) {
      repo = row.repo;
      lines.push(`${repo}:`);
    }
    const spec = REPO_CAPABILITIES[row.capability];
    const state = row.declared ? "declared" : "not declared";
    const fit = !row.fit.reported
      ? "installation not reported"
      : row.fit.ok
        ? "the installation grants it"
        : `the installation does NOT grant ${row.fit.missing.map((m) => `${m.family}:${m.need}`).join(", ")}`;
    lines.push(`  ${row.capability} — ${state}; ${fit}. ${spec?.summary ?? ""}`);
    if (!row.declared) {
      lines.push(`    to add: repos: [{ repo: "${row.repo}", capabilities: ["${row.capability}"] }] in agent/access/bundles.ts`);
    }
    if (row.fit.reported && !row.fit.ok) {
      const owner = repoOwner(row.repo);
      const id = installationIdByOwner[owner];
      lines.push(
        `    first: update the GitHub App's repository permissions, then the installation owner (${owner}) approves the update at ` +
          (id ? installationApprovalUrls(owner, id).join(" or ") : "the installation's settings page") +
          ".",
      );
    }
  }
  return lines;
}
