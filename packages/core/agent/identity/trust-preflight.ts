import type { Check } from "../ops/quickstart.js";
import { registerPreflightProbe } from "../ops/probes.js";
import { parseSurfaceKeyEntry, surfaceKeyEntryMatches, surfaceKeyEntrySpecificity } from "./surface-key-grammar.js";
import { registeredSurfaces, type Surface } from "./trust.js";

export interface SurfaceTraffic {
  readonly surfaceKey: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly enterpriseKey?: string;
  readonly groupKey?: string;
  readonly containerKey?: string;
}

export interface SurfaceTrustPreflightInput {
  readonly entries: readonly Surface[];
  readonly traffic: readonly SurfaceTraffic[];
  readonly now: Date;
  readonly deadEntryDays?: number;
  readonly newSurfaceDays?: number;
}

const DEFAULT_DEAD_ENTRY_DAYS = 30;
const DEFAULT_NEW_SURFACE_DAYS = 7;
const DAY_MS = 86_400_000;

const MAX_NAMED = 8;

function nameList(keys: readonly string[]): string {
  const shown = keys.slice(0, MAX_NAMED).join(", ");
  return keys.length > MAX_NAMED ? `${shown}, … (+${keys.length - MAX_NAMED} more)` : shown;
}

function ageDays(now: Date, iso: string): number | undefined {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / DAY_MS : undefined;
}

export function undeclaredSurfacesFix(undeclared: readonly string[]): string {
  const example = undeclared[0] ?? "";
  const teamsRemedy =
    `add a line to agent/identity/surfaces.ts declaring the TENANT — defineSurface({ key: "teams/<tenantId>", ` +
    `trust: "internal" }). A declaration counts at any rung, so that covers every room under the tenant; declare a ` +
    `single "teams/<tenantId>/<threadId>" key instead to narrow it to one channel. ONE line is enough either way, ` +
    `including for a member of a cross-surface SINGLE WINDOW: the window privacy floor walks the declaration rungs ` +
    `too (OPE-1521), so a tenant declaration admits the room. 🔴 Weigh the REACH before you pick the tenant grain — it ` +
    `covers rooms you never named, a cross-tenant Connect/shared channel among them, because an inbound Teams activity ` +
    `usually omits membershipType. Declare the channel to narrow it. See docs/deploy/surfaces/teams.md`;
  if (example.startsWith("teams/")) return `${teamsRemedy} — this deployment's undeclared example is "${example}".`;

  const generic =
    `add a line per surface to agent/identity/surfaces.ts — defineSurface({ key: "${example}", trust: "internal" }) ` +
    `if only organisation members can type there, or trust: "public" if anyone can. Declaring the tenant ` +
    `(e.g. "${example.split("/").slice(0, 2).join("/")}") covers every room under it.`;
  return undeclared.some((k) => k.startsWith("teams/")) ? `${generic} FOR THE TEAMS SURFACE(S) ABOVE, instead: ${teamsRemedy}.` : generic;
}

export function surfaceTrustPreflightChecks(input: SurfaceTrustPreflightInput): Check[] {
  const deadDays = input.deadEntryDays ?? DEFAULT_DEAD_ENTRY_DAYS;
  const newDays = input.newSurfaceDays ?? DEFAULT_NEW_SURFACE_DAYS;
  const checks: Check[] = [];

  const parsed = input.entries.flatMap((surface) => {
    const entry = parseSurfaceKeyEntry(surface.key);
    return entry ? [{ surface, entry }] : [];
  });

  if (input.traffic.length === 0) {
    checks.push({
      name: "surface trust: traffic",
      status: "info",
      detail:
        parsed.length === 0
          ? "no surfaces declared and no traffic recorded — declare each room in agent/identity/surfaces.ts once it starts being used"
          : `${parsed.length} surface declaration(s), no traffic recorded yet — the undeclared-surface check cannot run`,
    });
    return checks;
  }

  const undeclared: string[] = [];
  const matchedEntries = new Set<string>();
  const matchedByPattern = new Map<string, string[]>();
  for (const t of input.traffic) {
    const segs = t.surfaceKey.split("/");
    const tenantKey = segs.slice(0, 2).join("/");
    const rungs = [
      t.surfaceKey,
      ...(t.containerKey === undefined || t.containerKey === t.surfaceKey ? [] : [t.containerKey]),
      ...(t.groupKey === undefined ? [] : [t.groupKey]),
      tenantKey,
      ...(t.enterpriseKey === undefined ? [] : [t.enterpriseKey]),
    ];
    const hits = parsed.filter(({ entry }) => rungs.some((k) => surfaceKeyEntryMatches(entry, k)));
    if (hits.length === 0) {
      undeclared.push(t.surfaceKey);
      continue;
    }
    for (const h of hits) matchedEntries.add(h.surface.key);
    const decider = hits.reduce((a, b) => (surfaceKeyEntrySpecificity(b.entry) > surfaceKeyEntrySpecificity(a.entry) ? b : a));
    const isPattern = decider.entry.kind === "tenant" || decider.entry.kind === "group" || decider.entry.glob;
    const age = ageDays(input.now, t.firstSeen);
    if (isPattern && age !== undefined && age <= newDays) {
      matchedByPattern.set(decider.surface.key, [...(matchedByPattern.get(decider.surface.key) ?? []), t.surfaceKey]);
    }
  }
  checks.push(
    undeclared.length === 0
      ? {
          name: "surface trust: undeclared surfaces",
          status: "ok",
          detail: `every surface with traffic (${input.traffic.length}) is covered by a declaration`,
        }
      : {
          name: "surface trust: undeclared surfaces",
          status: "missing",
          detail: `${undeclared.length} surface(s) have traffic but NO trust declaration: ${nameList(undeclared)}`,
          fix: undeclaredSurfacesFix(undeclared),
        },
  );

  const newestTraffic = input.traffic.reduce((a, t) => Math.max(a, Date.parse(t.lastSeen) || 0), 0);
  const observedDays = ageDays(input.now, new Date(newestTraffic).toISOString());
  const dead = parsed.filter(({ surface }) => !matchedEntries.has(surface.key)).map(({ surface }) => surface.key);
  if (dead.length > 0 && observedDays !== undefined && observedDays <= deadDays) {
    checks.push({
      name: "surface trust: dead declarations",
      status: "info",
      detail: `${dead.length} declaration(s) matched no traffic in the last ${deadDays} days: ${nameList(dead)}`,
      fix:
        "a room can be archived, a repo transferred, a Linear team deleted — the key then stops matching and the surface falls back to fail-closed external, which is correct but silent. " +
        "🔴 CHECK THE GRAIN BEFORE YOU DELETE ANYTHING. A traffic row names ONE workspace and ONE room, so a live declaration written at any CONTAINER matches no row and still lands here. THREE shapes do that. (1) A Slack Enterprise Grid line (`slack/E…`) vouches whole workspaces (OPE-1508). (2) A Teams group line (`teams/<tenant>/team:…`) vouches a team's channels (OPE-490). (3) A Teams CHANNEL line (`teams/<tenant>/<channelId>`) vouches the reply chains inside that channel — and a traffic row names the reply CHAIN, because the deployment records the conversation id as the room. This check reads all three, but only when the traffic row carries them, and the live loader carries none of them yet — OPE-1560 holds that half. So a working Grid, group or channel declaration reports as dead. Deleting one silently returns every workspace, channel or reply chain under it to non-member. " +
        "Confirm each is intentional, then delete the line or fix the key.",
    });
  }

  for (const [entryKey, surfaces] of [...matchedByPattern.entries()].sort()) {
    checks.push({
      name: `surface trust: new matches for "${entryKey}"`,
      status: "info",
      detail: `${surfaces.length} surface(s) started matching this pattern in the last ${newDays} days: ${nameList(surfaces)}`,
      fix: `confirm each one should carry this declaration's trust. A pattern admits surfaces nobody enumerated, so a rename INTO its prefix inherits it — this row DETECTS that, it cannot prevent it. To pin one surface, add an exact entry: an exact key always beats a pattern.`,
    });
  }

  return checks;
}

export interface SurfaceAuditRow {
  readonly ts: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
}

export function surfaceTrafficFromAudit(rows: readonly SurfaceAuditRow[]): SurfaceTraffic[] {
  const byKey = new Map<string, { first: string; last: string }>();
  for (const r of rows) {
    if (!r.surface || !r.platform || !r.workspace) continue;
    const key = `${r.platform}/${r.workspace}/${r.surface}`;
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { first: r.ts, last: r.ts });
    else byKey.set(key, { first: r.ts < seen.first ? r.ts : seen.first, last: r.ts > seen.last ? r.ts : seen.last });
  }
  return [...byKey.entries()]
    .map(([surfaceKey, v]) => ({ surfaceKey, firstSeen: v.first, lastSeen: v.last }))
    .sort((a, b) => a.surfaceKey.localeCompare(b.surfaceKey));
}

export interface SurfaceTrustProbeDeps {
  readonly entries?: () => readonly Surface[];
  readonly auditRows?: () => Promise<readonly SurfaceAuditRow[]>;
  readonly now?: () => Date;
}

export function registerSurfaceTrustPreflight(deps: SurfaceTrustProbeDeps = {}): void {
  registerPreflightProbe("surface-trust", async () => {
    const entries = (deps.entries ?? registeredSurfaces)();
    const now = (deps.now ?? (() => new Date()))();
    const read =
      deps.auditRows ??
      (async () => {
        const { readAudit } = await import("../audit/audit.js");
        const { deploymentOrg } = await import("./binding.js");
        const since = new Date(now.getTime() - 90 * DAY_MS).toISOString();
        return (await readAudit({ org: deploymentOrg(), since, limit: 5000 })) as readonly SurfaceAuditRow[];
      });
    let traffic: readonly SurfaceTraffic[];
    try {
      traffic = surfaceTrafficFromAudit(await read());
    } catch (err) {
      return [
        {
          name: "surface trust: traffic",
          status: "info" as const,
          detail: `could not read the audit log to find which surfaces have traffic — ${err instanceof Error ? err.message : String(err)}`,
          fix: "the undeclared-surface check needs the deployment's operational store; set DATABASE_URL (or OE_SQLITE_PATH) in the project's .env.local and re-run",
        },
      ];
    }
    return surfaceTrustPreflightChecks({ entries, traffic, now });
  });
}
