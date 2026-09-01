import { awsCommandVerdict, cliOpToIamAction } from "./aws-screen.js";

export interface EvidenceRow {
  readonly ts: string;
  readonly action: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface EvidenceWindow {
  readonly since: string;
  readonly until: string;
  readonly days: number;
}

export interface DeclaredGrants {
  readonly bundle: string;
  readonly awsRoles: readonly { readonly roleArn: string; readonly allow: readonly string[] }[];
  readonly connectors: readonly string[];
}

export interface CountedLabel {
  readonly label: string;
  readonly count: number;
}

export const MIN_TIGHTEN_OBSERVATIONS = 5;

export const MIN_TIGHTEN_WINDOW_DAYS = 7;

export const MIN_WIDEN_REFUSALS = 2;

export interface AwsRefusalEvidence {
  readonly kind: "aws-allow-list";
  readonly roleArn: string;
  readonly command: string;
  readonly iamEntry: string;
  readonly allow: readonly string[];
  readonly refusals: number;
  readonly unattendedRefusals: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface ChainDenyEvidence {
  readonly kind: "chain-deny";
  readonly tool: string;
  readonly denies: number;
  readonly unattendedDenies: number;
  readonly reasons: readonly CountedLabel[];
  readonly resolvedBy: readonly CountedLabel[];
  readonly domains: readonly string[];
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface EgressDenialEvidence {
  readonly kind: "egress-denied";
  readonly host: string;
  readonly denials: number;
  readonly windows: number;
  readonly fingerprints: readonly string[];
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface ConnectorRefusalEvidence {
  readonly kind: "connector-refused";
  readonly connection: string;
  readonly refusals: number;
  readonly reasons: readonly CountedLabel[];
  readonly ops: readonly CountedLabel[];
  readonly tiers: readonly CountedLabel[];
  readonly ungranted: number;
  readonly liftableUnattended: number;
  readonly unroutedUnattended: number;
  readonly grantedSinceUnattended: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export type RefusalEvidence = AwsRefusalEvidence | ChainDenyEvidence | EgressDenialEvidence | ConnectorRefusalEvidence;

export interface AwsGrantUsage {
  readonly kind: "aws-role";
  readonly bundles: readonly string[];
  readonly roleArn: string;
  readonly allow: readonly string[];
  readonly uses: number;
  readonly commands: readonly CountedLabel[];
  readonly covering: readonly string[];
  readonly unexercised: readonly string[];
  readonly services: readonly string[];
  readonly lastUsed?: string;
}

export interface ConnectorGrantUsage {
  readonly kind: "connector";
  readonly bundle: string;
  readonly connector: string;
  readonly bundleConnectors: readonly string[];
  readonly uses: number;
  readonly ops: readonly CountedLabel[];
  readonly lastUsed?: string;
}

export type GrantUsage = AwsGrantUsage | ConnectorGrantUsage;

export interface EvidenceActivity {
  readonly awsExec: number;
  readonly connectorOps: number;
  readonly chainResolutions: number;
  readonly egressDenialRows: number;
}

export interface PermissionEvidence {
  readonly window: EvidenceWindow;
  readonly rowsConsidered: number;
  readonly activity: EvidenceActivity;
  readonly refusals: readonly RefusalEvidence[];
  readonly usage: readonly GrantUsage[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strArray(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as readonly string[]) : undefined;
}

function counted(counts: ReadonlyMap<string, number>): CountedLabel[] {
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

export function argvOfCommandLabel(label: string): readonly string[] {
  const sep = label.indexOf(":");
  if (sep < 0) return [label];
  return [label.slice(0, sep), label.slice(sep + 1)];
}

export function iamEntryForCommandLabel(label: string): string {
  const [service, op] = argvOfCommandLabel(label);
  if (op === undefined) return service ?? label;
  return `${service}:${cliOpToIamAction(op)}`;
}

export function entryCoversCommand(entry: string, commandLabel: string): boolean {
  return awsCommandVerdict({ argv: argvOfCommandLabel(commandLabel), allow: [entry] }).ok;
}

export function makeWindow(days: number, now: Date): EvidenceWindow {
  const until = now.toISOString();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return { since, until, days };
}

function inWindow(row: EvidenceRow, w: EvidenceWindow): boolean {
  return row.ts >= w.since && row.ts <= w.until;
}

export function refusalEvidence(rows: readonly EvidenceRow[], window: EvidenceWindow): readonly RefusalEvidence[] {
  interface AwsAcc {
    roleArn: string;
    command: string;
    allow: readonly string[];
    refusals: number;
    unattended: number;
    first: string;
    last: string;
  }
  const aws = new Map<string, AwsAcc>();

  interface ChainAcc {
    tool: string;
    denies: number;
    unattended: number;
    reasons: Map<string, number>;
    resolvedBy: Map<string, number>;
    domains: Set<string>;
    first: string;
    last: string;
  }
  const chain = new Map<string, ChainAcc>();

  interface EgressAcc {
    host: string;
    denials: number;
    windows: number;
    fingerprints: Set<string>;
    first: string;
    last: string;
  }
  const egress = new Map<string, EgressAcc>();

  interface ConnAcc {
    connection: string;
    refusals: number;
    reasons: Map<string, number>;
    ops: Map<string, number>;
    tiers: Map<string, number>;
    ungranted: number;
    liftable: number;
    unrouted: number;
    grantedSince: number;
    first: string;
    last: string;
  }
  const connectorRefused = new Map<string, ConnAcc>();

  const grantedAt = new Map<string, string>();
  for (const row of rows) {
    if (!inWindow(row, window)) continue;
    if (row.action !== "routine.permission_granted" && row.action !== "connector.unattended_lift") continue;
    const d = row.detail ?? {};
    const routineKey = row.action === "routine.permission_granted" ? str(d.key) : str(d.routine);
    const grantKind = str(d.grant);
    if (routineKey === undefined || grantKind === undefined) continue;
    const joinKey = `${routineKey}\u0000${grantKind}`;
    const prior = grantedAt.get(joinKey);
    if (prior === undefined || row.ts > prior) grantedAt.set(joinKey, row.ts);
  }

  for (const row of rows) {
    if (!inWindow(row, window)) continue;
    const d = row.detail ?? {};

    if (row.action === "aws.refused") {
      if (str(d.reason) !== "allow-list") continue;
      const roleArn = str(d.roleArn);
      const command = str(d.command);
      if (roleArn === undefined || command === undefined) continue;
      const key = `${roleArn}\u0000${command}`;
      const prior = aws.get(key);
      const allow = strArray(d.allow) ?? prior?.allow ?? [];
      aws.set(key, {
        roleArn,
        command,
        allow,
        refusals: (prior?.refusals ?? 0) + 1,
        unattended: (prior?.unattended ?? 0) + (d.unattended === true ? 1 : 0),
        first: prior === undefined || row.ts < prior.first ? row.ts : prior.first,
        last: prior === undefined || row.ts > prior.last ? row.ts : prior.last,
      });
      continue;
    }

    if (row.action === "egress.denied") {
      const host = str(d.host);
      const rawCount = typeof d.count === "number" ? d.count : 1;
      if (host === undefined || !Number.isInteger(rawCount) || rawCount <= 0) continue;
      let acc = egress.get(host);
      if (acc === undefined) {
        acc = { host, denials: 0, windows: 0, fingerprints: new Set(), first: row.ts, last: row.ts };
        egress.set(host, acc);
      }
      acc.denials += rawCount;
      acc.windows++;
      const fp = str(d.policyFingerprint);
      if (fp !== undefined) acc.fingerprints.add(fp);
      if (row.ts < acc.first) acc.first = row.ts;
      if (row.ts > acc.last) acc.last = row.ts;
      continue;
    }

    if (row.action === "connector.refused") {
      const connection = str(d.connection);
      if (connection === undefined) continue;
      let acc = connectorRefused.get(connection);
      if (acc === undefined) {
        acc = {
          connection,
          refusals: 0,
          reasons: new Map(),
          ops: new Map(),
          tiers: new Map(),
          ungranted: 0,
          liftable: 0,
          unrouted: 0,
          grantedSince: 0,
          first: row.ts,
          last: row.ts,
        };
        connectorRefused.set(connection, acc);
      }
      acc.refusals++;
      if (row.ts < acc.first) acc.first = row.ts;
      if (row.ts > acc.last) acc.last = row.ts;
      const reason = str(d.reason);
      bump(acc.reasons, reason ?? "unrecorded");
      const op = str(d.op);
      if (op !== undefined) bump(acc.ops, op);
      const tier = str(d.tier);
      if (tier !== undefined) bump(acc.tiers, tier);
      if (reason === "ungranted") acc.ungranted++;
      if (reason === "ask-unattended" && tier === "write") {
        const routineKey = str(d.routine);
        const grantKind = str(d.grant);
        const arrived = routineKey === undefined || grantKind === undefined ? undefined : grantedAt.get(`${routineKey}\u0000${grantKind}`);
        if (routineKey === undefined) acc.unrouted++;
        else if (arrived !== undefined && arrived > row.ts) acc.grantedSince++;
        else acc.liftable++;
      }
      continue;
    }

    if (row.action === "approval.chain") {
      if (str(d.verdict) !== "deny") continue;
      const tool = str(d.tool);
      if (tool === undefined) continue;
      let acc = chain.get(tool);
      if (acc === undefined) {
        acc = {
          tool,
          denies: 0,
          unattended: 0,
          reasons: new Map(),
          resolvedBy: new Map(),
          domains: new Set(),
          first: row.ts,
          last: row.ts,
        };
        chain.set(tool, acc);
      }
      acc.denies++;
      if (d.unattended === true) acc.unattended++;
      if (row.ts < acc.first) acc.first = row.ts;
      if (row.ts > acc.last) acc.last = row.ts;
      const domain = str(d.domain);
      if (domain !== undefined) acc.domains.add(domain);
      const resolvedBy = str(d.resolvedBy);
      if (resolvedBy !== undefined) bump(acc.resolvedBy, resolvedBy);
      const transforms = Array.isArray(d.transforms) ? (d.transforms as readonly unknown[]) : [];
      const denyReasons = transforms
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
        .filter((t) => t.to === "deny")
        .map((t) => str(t.reason) ?? "transform")
        .sort();
      if (denyReasons.length === 0) bump(acc.reasons, "element");
      else for (const r of denyReasons) bump(acc.reasons, r);
    }
  }

  const awsOut: AwsRefusalEvidence[] = [...aws.values()]
    .map((a) => ({
      kind: "aws-allow-list" as const,
      roleArn: a.roleArn,
      command: a.command,
      iamEntry: iamEntryForCommandLabel(a.command),
      allow: a.allow,
      refusals: a.refusals,
      unattendedRefusals: a.unattended,
      firstSeen: a.first,
      lastSeen: a.last,
    }))
    .sort((x, y) => y.refusals - x.refusals || x.roleArn.localeCompare(y.roleArn) || x.command.localeCompare(y.command));

  const chainOut: ChainDenyEvidence[] = [...chain.values()]
    .map((c) => ({
      kind: "chain-deny" as const,
      tool: c.tool,
      denies: c.denies,
      unattendedDenies: c.unattended,
      reasons: counted(c.reasons),
      resolvedBy: counted(c.resolvedBy),
      domains: [...c.domains].sort(),
      firstSeen: c.first,
      lastSeen: c.last,
    }))
    .sort((x, y) => y.denies - x.denies || x.tool.localeCompare(y.tool));

  const egressOut: EgressDenialEvidence[] = [...egress.values()]
    .map((e) => ({
      kind: "egress-denied" as const,
      host: e.host,
      denials: e.denials,
      windows: e.windows,
      fingerprints: [...e.fingerprints].sort(),
      firstSeen: e.first,
      lastSeen: e.last,
    }))
    .sort((x, y) => y.denials - x.denials || x.host.localeCompare(y.host));

  const connectorOut: ConnectorRefusalEvidence[] = [...connectorRefused.values()]
    .map((c) => ({
      kind: "connector-refused" as const,
      connection: c.connection,
      refusals: c.refusals,
      reasons: counted(c.reasons),
      ops: counted(c.ops),
      tiers: counted(c.tiers),
      ungranted: c.ungranted,
      liftableUnattended: c.liftable,
      unroutedUnattended: c.unrouted,
      grantedSinceUnattended: c.grantedSince,
      firstSeen: c.first,
      lastSeen: c.last,
    }))
    .sort((x, y) => y.refusals - x.refusals || x.connection.localeCompare(y.connection));

  return [...awsOut, ...chainOut, ...egressOut, ...connectorOut];
}

export function grantUsageEvidence(
  rows: readonly EvidenceRow[],
  grants: readonly DeclaredGrants[],
  window: EvidenceWindow,
): readonly GrantUsage[] {
  const awsByRole = new Map<string, { commands: Map<string, number>; uses: number; last?: string }>();
  const connByName = new Map<string, { ops: Map<string, number>; uses: number; last?: string }>();

  for (const row of rows) {
    if (!inWindow(row, window)) continue;
    const d = row.detail ?? {};
    if (row.action === "aws.exec") {
      const roleArn = str(d.roleArn);
      const command = str(d.command);
      if (roleArn === undefined || command === undefined) continue;
      let acc = awsByRole.get(roleArn);
      if (acc === undefined) {
        acc = { commands: new Map(), uses: 0 };
        awsByRole.set(roleArn, acc);
      }
      acc.uses++;
      bump(acc.commands, command);
      if (acc.last === undefined || row.ts > acc.last) acc.last = row.ts;
      continue;
    }
    if (row.action === "connector.op") {
      const connection = str(d.connection);
      const op = str(d.op);
      if (connection === undefined) continue;
      let acc = connByName.get(connection);
      if (acc === undefined) {
        acc = { ops: new Map(), uses: 0 };
        connByName.set(connection, acc);
      }
      acc.uses++;
      if (op !== undefined) bump(acc.ops, op);
      if (acc.last === undefined || row.ts > acc.last) acc.last = row.ts;
    }
  }

  const awsBundles = new Map<string, { bundles: Set<string>; allow: readonly string[] }>();
  for (const g of grants) {
    for (const r of g.awsRoles) {
      const prior = awsBundles.get(r.roleArn);
      if (prior === undefined) awsBundles.set(r.roleArn, { bundles: new Set([g.bundle]), allow: r.allow });
      else prior.bundles.add(g.bundle);
    }
  }

  const out: GrantUsage[] = [];

  for (const [roleArn, decl] of [...awsBundles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const observed = awsByRole.get(roleArn);
    const commands = observed === undefined ? [] : counted(observed.commands);
    const covering = decl.allow.filter((entry) => commands.some((c) => entryCoversCommand(entry, c.label)));
    const unexercised = decl.allow.filter((entry) => !covering.includes(entry));
    const services = [...new Set(commands.map((c) => argvOfCommandLabel(c.label)[0] ?? ""))].filter((s) => s.length > 0).sort();
    out.push({
      kind: "aws-role",
      bundles: [...decl.bundles].sort(),
      roleArn,
      allow: decl.allow,
      uses: observed?.uses ?? 0,
      commands,
      covering,
      unexercised,
      services,
      ...(observed?.last !== undefined ? { lastUsed: observed.last } : {}),
    });
  }

  for (const g of grants) {
    for (const connector of g.connectors) {
      const observed = connByName.get(connector);
      out.push({
        kind: "connector",
        bundle: g.bundle,
        connector,
        bundleConnectors: g.connectors,
        uses: observed?.uses ?? 0,
        ops: observed === undefined ? [] : counted(observed.ops),
        ...(observed?.last !== undefined ? { lastUsed: observed.last } : {}),
      });
    }
  }

  return out;
}

export function permissionEvidence(
  rows: readonly EvidenceRow[],
  grants: readonly DeclaredGrants[],
  window: EvidenceWindow,
): PermissionEvidence {
  const inside = rows.filter((r) => inWindow(r, window));
  return {
    window,
    rowsConsidered: inside.length,
    activity: {
      awsExec: inside.filter((r) => r.action === "aws.exec").length,
      connectorOps: inside.filter((r) => r.action === "connector.op").length,
      chainResolutions: inside.filter((r) => r.action === "approval.chain").length,
      egressDenialRows: inside.filter((r) => r.action === "egress.denied").length,
    },
    refusals: refusalEvidence(rows, window),
    usage: grantUsageEvidence(rows, grants, window),
  };
}
