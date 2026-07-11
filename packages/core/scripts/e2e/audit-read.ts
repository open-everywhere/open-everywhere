export interface AuditWireEntry {
  readonly ts: string;
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly action: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface AuditQueryOpts {
  readonly sinceIso: string;
  readonly actions?: readonly string[];
  readonly platform?: string;
  readonly workspace?: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly limit?: number;
}

export function buildAuditQuery(opts: AuditQueryOpts): string {
  const params = new URLSearchParams({ since: opts.sinceIso });
  if (opts.actions && opts.actions.length > 0) params.set("actions", opts.actions.join(","));
  if (opts.platform) params.set("platform", opts.platform);
  if (opts.workspace) params.set("workspace", opts.workspace);
  if (opts.surface) params.set("surface", opts.surface);
  if (opts.principalId) params.set("principalId", opts.principalId);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  return params.toString();
}

export async function fetchAudit(targetUrl: string, readToken: string, opts: AuditQueryOpts): Promise<readonly AuditWireEntry[]> {
  const base = targetUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/control/v1/audit?${buildAuditQuery(opts)}`, {
    headers: { authorization: `Bearer ${readToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`GET /control/v1/audit → ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  const parsed = (await res.json()) as { entries?: AuditWireEntry[] };
  if (!Array.isArray(parsed.entries)) throw new Error("GET /control/v1/audit returned no entries array (malformed response)");
  return parsed.entries;
}

export function hasAuditRow(
  rows: readonly AuditWireEntry[],
  action: string,
  where?: (e: AuditWireEntry) => boolean,
): boolean {
  return rows.some((e) => e.action === action && (where === undefined || where(e)));
}

export interface UnifiedAuditWire {
  readonly org: string;
  readonly domain: string;
  readonly unified: boolean;
  readonly platforms: readonly string[];
  readonly containers: readonly { readonly surfaceKey: string; readonly platform: string }[];
  readonly humans: readonly { readonly name: string; readonly surfacesNotIn: readonly string[] }[];
  readonly behaviour: { readonly entries: readonly AuditWireEntry[] };
  readonly notes: readonly string[];
}

export interface UnifiedAuditCallResult {
  readonly status: number;
  readonly body?: unknown;
}

export type UnifiedAuditCall = (query: string, token?: string) => Promise<UnifiedAuditCallResult>;

export function buildUnifiedAuditQuery(opts: { domain?: string; sinceDays?: number }): string {
  const params = new URLSearchParams();
  if (opts.domain) params.set("domain", opts.domain);
  if (opts.sinceDays !== undefined) params.set("sinceDays", String(opts.sinceDays));
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

export async function callUnifiedAudit(targetUrl: string, readToken: string, query: string): Promise<UnifiedAuditCallResult> {
  const base = targetUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/control/v1/unified-audit${query}`, {
    headers: { authorization: `Bearer ${readToken}`, accept: "application/json" },
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, ...(body !== undefined ? { body } : {}) };
}
