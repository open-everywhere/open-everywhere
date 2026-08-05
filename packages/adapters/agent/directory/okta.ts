import { getSecretVia, type DirectoryAccount, type DirectoryPerson, type DirectoryProvider } from "@open-everywhere/core/agent/adapter-api.js";
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

  async function getAll<T>(path: string, token: string): Promise<T[]> {
    let url: string | undefined = path.startsWith("http") ? path : `${config.orgUrl}${path}`;
    const out: T[] = [];
    for (let page = 0; url && page < MAX_PAGES; page++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "GET",
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

  async function groupsByUser(token: string): Promise<Map<string, string[]>> {
    const byUser = new Map<string, string[]>();
    const groups = await getAll<OktaGroup>(`/api/v1/groups?limit=${PAGE_LIMIT}`, token);
    for (const group of groups) {
      const name = group.profile?.name?.trim();
      if (!group.id || !name) continue;
      const members = await getAll<OktaUser>(`/api/v1/groups/${encodeURIComponent(group.id)}/users?limit=${PAGE_LIMIT}`, token);
      for (const m of members) {
        if (!m.id) continue;
        const list = byUser.get(m.id) ?? [];
        list.push(name);
        byUser.set(m.id, list);
      }
    }
    return byUser;
  }

  async function accountsByUser(token: string): Promise<Map<string, DirectoryAccount[]>> {
    const byUser = new Map<string, DirectoryAccount[]>();
    for (const app of config.apps) {
      const assignments = await getAll<OktaAppUser>(`/api/v1/apps/${encodeURIComponent(app.appId)}/users?limit=${APP_PAGE_LIMIT}`, token);
      for (const a of assignments) {
        if (!a.id) continue;
        if (a.status && DEPROVISIONED_STATUSES.has(a.status.toUpperCase())) continue;
        const nativeId = appSideId(a, app);
        if (!nativeId) continue;
        const list = byUser.get(a.id) ?? [];
        list.push({ platform: app.platform, nativeId, grade: "attested" });
        byUser.set(a.id, list);
      }
    }
    return byUser;
  }

  return {
    id: "okta",
    name: `Okta (${config.orgUrl})`,
    async listPeople(): Promise<readonly DirectoryPerson[]> {
      const token = await resolveToken(config.tokenBroker, config.tokenRef);
      const users = await getAll<OktaUser>(`/api/v1/users?limit=${PAGE_LIMIT}`, token);
      const groups = await groupsByUser(token);
      const accounts = await accountsByUser(token);

      const people: DirectoryPerson[] = [];
      for (const user of users) {
        if (!user.id) continue;
        const email = user.profile?.email?.trim();
        people.push({
          externalId: user.id,
          displayName: displayNameOf(user),
          ...(email ? { email } : {}),
          accounts: accounts.get(user.id) ?? [],
          groups: (groups.get(user.id) ?? []).slice().sort(),
          deprovisioned: DEPROVISIONED_STATUSES.has((user.status ?? "").toUpperCase()),
        });
      }
      return people;
    },
  };
}

function appSideId(assignment: OktaAppUser, app: OktaAppMapping): string | undefined {
  const raw = app.field === "userName" ? assignment.credentials?.userName : assignment.externalId;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
