import { readAudit as defaultReadAudit } from "../audit/audit.js";
import type { AuditEntry } from "../audit/audit.js";
import { siloTier, type Tier } from "./store.js";
import { tierSandboxDir } from "./sandbox-sync.js";
import { getConfig } from "../access/config.js";
import { domainForChannel, criteriaDomain, memoryRefs, unifiedSupervisorOrgGateEnabled, type Domain } from "./domain.js";

export interface MemoryDeltaSilo {
  readonly tier: Tier;
  readonly siloName: string;
}

export interface MemoryDeltaPointer {
  readonly path: string;
  readonly siloName: string;
  readonly writes: number;
  readonly latestVersion?: string;
}

export interface RenderMemoryDeltaOpts {
  readonly org: string;
  readonly silos: readonly MemoryDeltaSilo[];
  readonly sinceIso: string;
  readonly atIso?: string;
  readonly selfKey?: string;
  readonly readAudit?: (filter: { org: string; action: string; since: string }) => Promise<AuditEntry[]>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function selectChangedSilos(rows: readonly AuditEntry[], opts: RenderMemoryDeltaOpts): MemoryDeltaPointer[] {
  const tierByName = new Map<string, Tier>(opts.silos.map((s) => [s.siloName, s.tier]));
  const agg = new Map<string, { pointer: MemoryDeltaPointer; ts: string }>();
  for (const row of rows) {
    const detail = row.detail ?? {};
    const siloName = str(detail.silo);
    if (!siloName || !tierByName.has(siloName)) continue;
    if (!(row.ts > opts.sinceIso)) continue;
    if (opts.atIso && row.ts > opts.atIso) continue;
    if (opts.selfKey && (str(detail.continuationToken) === opts.selfKey || str(detail.sessionId) === opts.selfKey)) {
      continue;
    }
    const existing = agg.get(siloName);
    if (existing) {
      existing.pointer = { ...existing.pointer, writes: existing.pointer.writes + 1 };
      continue;
    }
    agg.set(siloName, {
      ts: row.ts,
      pointer: {
        path: tierSandboxDir(tierByName.get(siloName)!),
        siloName,
        writes: 1,
        ...(str(detail.version) ? { latestVersion: str(detail.version) } : {}),
      },
    });
  }
  return [...agg.values()].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).map((e) => e.pointer);
}

export function formatMemoryDelta(pointers: readonly MemoryDeltaPointer[]): string | null {
  if (pointers.length === 0) return null;
  const lines = pointers.map((p) => {
    const count = p.writes > 1 ? ` (updated ${p.writes}×)` : " (updated)";
    return `- ${p.path} — silo "${p.siloName}"${count}`;
  });
  return (
    "<system-reminder>\n" +
    "Shared memory changed since your last wake — these are POINTERS, not content. The files on " +
    "disk are already refreshed; re-read a path with your file tools ONLY if it bears on the " +
    "current message, otherwise ignore it:\n" +
    lines.join("\n") +
    "\n</system-reminder>"
  );
}

export async function renderMemoryDelta(opts: RenderMemoryDeltaOpts): Promise<string | null> {
  if (opts.silos.length === 0) return null;
  try {
    const read = opts.readAudit ?? defaultReadAudit;
    const rows = await read({ org: opts.org, action: "memory.write", since: opts.sinceIso });
    return formatMemoryDelta(selectChangedSilos(rows, opts));
  } catch {
    return null;
  }
}

export function sessionReadSilos(surfaceKey: string, domains: readonly Domain[]): MemoryDeltaSilo[] {
  const domain = domainForChannel(surfaceKey, domains) ?? criteriaDomain("org", domains);
  if (!domain) return [];
  const names = new Set<string>(memoryRefs(domain));
  if (domain.includeOrg) {
    const org = criteriaDomain("org", domains);
    if (org) for (const n of memoryRefs(org)) names.add(n);
  }
  return [...names].map((siloName) => ({ tier: siloTier(siloName), siloName }));
}

export function liveMemoryDeltaDep(
  org: string,
  surfaceKey: string,
): ((sinceIso: string, atIso: string, selfKey?: string) => Promise<string | null>) | undefined {
  let domains: readonly Domain[];
  try {
    domains = getConfig().loadDomains();
  } catch {
    return undefined;
  }
  if (!unifiedSupervisorOrgGateEnabled(domains)) return undefined;
  const silos = sessionReadSilos(surfaceKey, domains);
  if (silos.length === 0) return undefined;
  return (sinceIso, atIso, selfKey) => renderMemoryDelta({ org, silos, sinceIso, atIso, selfKey });
}
