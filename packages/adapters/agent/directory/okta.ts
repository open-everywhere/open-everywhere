import {
  declaredConnectionSignIns,
  getSecretVia,
  OKTA_LINK_PLATFORM,
  type DirectoryAccount,
  type DirectoryGroupReport,
  type DirectoryInspection,
  type DirectoryPerson,
  type DirectoryProvider,
  type DirectorySourceReport,
} from "@open-everywhere/core/agent/adapter-api.js";
import type { OktaAppMapping, OktaDirectoryConfig } from "./config.js";

export type FetchLike = typeof fetch;

const DEPROVISIONED_STATUSES = new Set(["DEPROVISIONED", "SUSPENDED"]);

const PAGE_LIMIT = 200;
const APP_PAGE_LIMIT = 500;

const MAX_PAGES = 200;

interface OktaUser {
  readonly id?: string;
  readonly status?: string;
  readonly profile?: {
    readonly login?: string;
    readonly email?: string;
    readonly displayName?: string;
    readonly firstName?: string;
    readonly lastName?: string;
  };
}

interface OktaGroup {
  readonly id?: string;
  readonly profile?: { readonly name?: string };
}

interface OktaAppUser {
  readonly id?: string;
  readonly externalId?: string;
  readonly status?: string;
  readonly credentials?: { readonly userName?: string };
}

interface OktaError {
  readonly errorCode?: string;
  readonly errorSummary?: string;
}

export interface OktaDirectoryDeps {
  readonly config: OktaDirectoryConfig;
  readonly fetch?: FetchLike;
  readonly resolveToken?: (broker: string, ref: string) => Promise<string>;
  readonly proposeOwnAccount?: () => boolean;
}

export function xaaNamesOrg(orgUrl: string, declared: ReadonlyMap<string, unknown> = declaredConnectionSignIns()): boolean {
  let origin: string;
  try {
    origin = new URL(orgUrl).origin;
  } catch {
    return false;
  }
  for (const v of declared.values()) {
    const rec = v as { mode?: unknown; idpIssuer?: unknown };
    if (rec.mode !== "xaa" || typeof rec.idpIssuer !== "string") continue;
    try {
      if (new URL(rec.idpIssuer).origin === origin) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function displayNameOf(user: OktaUser): string {
  const p = user.profile ?? {};
  const full = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return p.displayName?.trim() || full || p.login?.trim() || p.email?.trim() || user.id || "unknown";
}

export function nextLink(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const m = /^\s*<([^>]+)>\s*;\s*(.+)$/u.exec(part);
    if (m && /\brel\s*=\s*"?next"?/u.test(m[2]!)) return m[1];
  }
  return undefined;
}

export function makeOktaDirectoryProvider(deps: OktaDirectoryDeps): DirectoryProvider {
  const { config } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const resolveToken = deps.resolveToken ?? ((broker: string, ref: string) => getSecretVia(broker, ref));
  const proposeOwnAccount = deps.proposeOwnAccount ?? (() => xaaNamesOrg(config.orgUrl));

  const orgOrigin = new URL(config.orgUrl).origin;

  async function getAll<T>(path: string, token: string, count: { requests: number }): Promise<T[]> {
    let url: string | undefined = path.startsWith("http") ? path : `${config.orgUrl}${path}`;
    const out: T[] = [];
    for (let page = 0; url && page < MAX_PAGES; page++) {
      let reqOrigin: string;
      try {
        reqOrigin = new URL(url).origin;
      } catch {
        throw new Error(`Okta pagination produced an unparseable URL — refusing to send the API token to it.`);
      }
      if (reqOrigin !== orgOrigin) {
        throw new Error(`Okta pagination tried to leave the org origin (${reqOrigin} ≠ ${orgOrigin}) — refusing to send the SSWS token off ${orgOrigin}.`);
      }
      let res: Response;
      count.requests++;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          headers: { authorization: `SSWS ${token}`, accept: "application/json" },
        });
      } catch (err) {
        throw new Error(`Okta request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        let detail = "";
        try {
          const body = (await res.json()) as OktaError;
          detail = [body.errorCode, body.errorSummary].filter(Boolean).join(" — ");
        } catch {
        }
        throw new Error(`Okta ${res.status} for ${url}${detail ? ` — ${detail}` : ""}`);
      }
      const body = (await res.json()) as unknown;
      if (Array.isArray(body)) out.push(...(body as T[]));
      url = nextLink(res.headers.get("link"));
    }
    return out;
  }

  async function groupsByUser(token: string, count: { requests: number }): Promise<{ byUser: Map<string, string[]>; report: DirectoryGroupReport }> {
    const byUser = new Map<string, string[]>();
    const allow = (config.groupAllowlist ?? []).length > 0 ? new Set(config.groupAllowlist) : undefined;
    const groups = await getAll<OktaGroup>(`/api/v1/groups?limit=${PAGE_LIMIT}`, token, count);
    const read: string[] = [];
    const seenNames = new Set<string>();
    let skipped = 0;
    for (const group of groups) {
      const name = group.profile?.name?.trim();
      if (!group.id || !name) continue;
      seenNames.add(name);
      if (allow && !allow.has(name)) {
        skipped++;
        continue;
      }
      read.push(name);
      const members = await getAll<OktaUser>(`/api/v1/groups/${encodeURIComponent(group.id)}/users?limit=${PAGE_LIMIT}`, token, count);
      for (const m of members) {
        if (!m.id) continue;
        const list = byUser.get(m.id) ?? [];
        list.push(name);
        byUser.set(m.id, list);
      }
    }
    return {
      byUser,
      report: {
        total: groups.length,
        read: read.slice().sort(),
        skipped,
        ...(allow ? { allowlist: [...allow] } : {}),
        allowlistMissing: allow ? [...allow].filter((n) => !seenNames.has(n)).sort() : [],
      },
    };
  }

  async function accountsByUser(token: string, count: { requests: number }): Promise<{ byUser: Map<string, DirectoryAccount[]>; reports: SourceTally[] }> {
    const byUser = new Map<string, DirectoryAccount[]>();
    const reports: SourceTally[] = [];
    for (const app of config.apps) {
      const grade = app.field === "userName" ? "asserted" : "attested";
      const tally = newTally(app, grade);
      reports.push(tally);
      const assignments = await getAll<OktaAppUser>(`/api/v1/apps/${encodeURIComponent(app.appId)}/users?limit=${APP_PAGE_LIMIT}`, token, count);
      tally.assignments = assignments.length;
      for (const a of assignments) {
        if (!a.id) {
          skip(tally, "the assignment carries no Okta user id", undefined);
          continue;
        }
        if (a.status && DEPROVISIONED_STATUSES.has(a.status.toUpperCase())) {
          skip(tally, `the assignment is ${a.status.toUpperCase()}`, a.id);
          continue;
        }
        const nativeId = appSideId(a, app);
        if (!nativeId) {
          skip(tally, app.field === "userName" ? "the assignment has no credentials.userName" : "the assignment has no externalId (the app never wrote an id back over SCIM)", a.id);
          continue;
        }
        const list = byUser.get(a.id) ?? [];
        list.push({ platform: app.platform, ...(app.tenant ? { tenant: app.tenant } : {}), nativeId, grade });
        byUser.set(a.id, list);
        tally.byUser.set(a.id, (tally.byUser.get(a.id) ?? 0) + 1);
      }
    }
    return { byUser, reports };
  }

  async function read(): Promise<DirectoryInspection> {
    const count = { requests: 0 };
    const token = await resolveToken(config.tokenBroker, config.tokenRef);
    const users = await getAll<OktaUser>(`/api/v1/users?limit=${PAGE_LIMIT}`, token, count);
    const groups = await groupsByUser(token, count);
    const accounts = await accountsByUser(token, count);
    const ownAccount = proposeOwnAccount();

    const people: DirectoryPerson[] = [];
    const listed = new Set<string>();
    for (const user of users) {
      if (!user.id) continue;
      listed.add(user.id);
      const email = user.profile?.email?.trim();
      people.push({
        externalId: user.id,
        displayName: displayNameOf(user),
        ...(email ? { email } : {}),
        accounts: ownAccount ? [...(accounts.byUser.get(user.id) ?? []), { platform: OKTA_LINK_PLATFORM, nativeId: user.id, grade: "attested" }] : (accounts.byUser.get(user.id) ?? []),
        groups: (groups.byUser.get(user.id) ?? []).slice().sort(),
        deprovisioned: DEPROVISIONED_STATUSES.has((user.status ?? "").toUpperCase()),
      });
    }
    const sources: DirectorySourceReport[] = accounts.reports.map((t) => {
      let mapped = 0;
      for (const [userId, n] of t.byUser) {
        if (listed.has(userId)) mapped += n;
        else for (let i = 0; i < n; i++) skip(t, "the Okta user is not in the user list (Okta's /users leaves out DEPROVISIONED users)", userId);
      }
      return {
        platform: t.platform,
        ...(t.tenant ? { tenant: t.tenant } : {}),
        source: t.source,
        field: t.field,
        grade: t.grade,
        assignments: t.assignments,
        mapped,
        skipped: [...t.skipped.entries()].map(([reason, v]) => ({ reason, count: v.count, examples: v.examples })),
      };
    });
    return { people, sources, groups: groups.report, requests: count.requests };
  }

  return {
    id: "okta",
    name: `Okta (${config.orgUrl})`,
    async listPeople(): Promise<readonly DirectoryPerson[]> {
      return (await read()).people;
    },
    inspect: read,
  };
}

interface SourceTally {
  readonly platform: string;
  readonly tenant?: string;
  readonly source: string;
  readonly field: string;
  readonly grade: "attested" | "asserted";
  assignments: number;
  readonly byUser: Map<string, number>;
  readonly skipped: Map<string, { count: number; examples: string[] }>;
}

const SKIP_EXAMPLES = 5;

function newTally(app: OktaAppMapping, grade: "attested" | "asserted"): SourceTally {
  return { platform: app.platform, ...(app.tenant ? { tenant: app.tenant } : {}), source: app.appId, field: app.field, grade, assignments: 0, byUser: new Map(), skipped: new Map() };
}

function skip(t: SourceTally, reason: string, userId: string | undefined): void {
  const entry = t.skipped.get(reason) ?? { count: 0, examples: [] };
  entry.count++;
  if (userId && entry.examples.length < SKIP_EXAMPLES && !entry.examples.includes(userId)) entry.examples.push(userId);
  t.skipped.set(reason, entry);
}

function appSideId(assignment: OktaAppUser, app: OktaAppMapping): string | undefined {
  const raw = app.field === "userName" ? assignment.credentials?.userName : assignment.externalId;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
