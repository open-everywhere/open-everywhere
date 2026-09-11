import { createHash } from "node:crypto";
import { prApiHeaders } from "../scm/pr.js";
import { parseConfigFacts, type ConfigFacts } from "./config-facts.js";

export const CONFIG_DIFF_STATUS_CONTEXT = "oe/config-diff";

const MAX_FACTS_DOCUMENT_BYTES = 8 * 1024 * 1024;

export interface StatusFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type StatusFetchFn = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<StatusFetchResponse>;

export interface CloudStatusProvenance {
  readonly repo: string;
  readonly headSha: string;
  readonly statusContext: string;
  readonly digest: string;
  readonly documentUrl: string;
  readonly sessionId: string | undefined;
  readonly postedAtIso: string | undefined;
  readonly postedBy: string | undefined;
}

export type CloudStatusFacts =
  | { readonly kind: "cloud-status"; readonly facts: ConfigFacts; readonly provenance: CloudStatusProvenance }
  | { readonly kind: "unavailable"; readonly reason: string };

export function configFactsDigest(document: string): string {
  return createHash("sha256").update(document, "utf8").digest("hex");
}

export function buildConfigDiffStatusDescription(input: { digest: string; sessionId?: string }): string {
  const head = `sha256:${input.digest}`;
  const full = input.sessionId ? `${head} session=${input.sessionId}` : head;
  return full.length <= 140 ? full : `${full.slice(0, 139)}…`;
}

export function parseConfigDiffStatusDescription(description: string | null | undefined): { digest: string; sessionId: string | undefined } | undefined {
  if (typeof description !== "string") return undefined;
  const digest = /(?:^|\s)sha256:([0-9a-f]{64})(?:\s|$)/u.exec(description);
  if (!digest) return undefined;
  const session = /(?:^|\s)session=([^\s]+)/u.exec(description);
  return { digest: digest[1], sessionId: session ? session[1] : undefined };
}

export function isAllowedFactsDocumentUrl(url: string, repo: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.host === "api.github.com") return parsed.pathname.startsWith(`/repos/${repo}/`);
  if (parsed.host === "raw.githubusercontent.com") return parsed.pathname.startsWith(`/${repo}/`);
  if (parsed.host === "github.com") return parsed.pathname.startsWith(`/${repo}/releases/download/`);
  return false;
}

interface CommitStatus {
  readonly context?: string;
  readonly description?: string | null;
  readonly target_url?: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly creator?: { login?: string } | null;
}

export interface FetchCloudStatusFactsOpts {
  readonly repo: string;
  readonly headSha: string;
  readonly token: string;
  readonly fetchFn?: StatusFetchFn;
  readonly apiBase?: string;
}

export async function fetchCloudStatusFacts(opts: FetchCloudStatusFactsOpts): Promise<CloudStatusFacts> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as StatusFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const headers = prApiHeaders(opts.token);
  const shortSha = opts.headSha.slice(0, 12);

  let statuses: readonly CommitStatus[];
  try {
    const res = await fetchFn(`${apiBase}/repos/${opts.repo}/commits/${encodeURIComponent(opts.headSha)}/statuses?per_page=100`, {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      return { kind: "unavailable", reason: `the commit-status listing for ${opts.repo}@${shortSha} failed: ${res.status} ${await safeText(res)}` };
    }
    const body = (await res.json()) as unknown;
    statuses = Array.isArray(body) ? (body as CommitStatus[]) : [];
  } catch (err) {
    return { kind: "unavailable", reason: `the commit-status listing could not be read: ${errText(err)}` };
  }

  const status = statuses.find((s) => s.context === CONFIG_DIFF_STATUS_CONTEXT);
  if (!status) {
    return {
      kind: "unavailable",
      reason:
        `no \`${CONFIG_DIFF_STATUS_CONTEXT}\` commit status exists on head sha ${shortSha} (${statuses.length} status(es) there). ` +
        `Either the cloud run that computes the resolved-config diff has not posted yet, or this deployment does not run one. ` +
        `This is an UNKNOWN — the config facts for this pull request are NOT established.`,
    };
  }

  const named = parseConfigDiffStatusDescription(status.description);
  if (!named) {
    return {
      kind: "unavailable",
      reason:
        `the \`${CONFIG_DIFF_STATUS_CONTEXT}\` status on ${shortSha} names no sha256 digest in its description, so it vouches for no ` +
        `particular document. Refusing to treat its existence as facts. This is an UNKNOWN, not a pass.`,
    };
  }

  const documentUrl = typeof status.target_url === "string" ? status.target_url : "";
  if (!isAllowedFactsDocumentUrl(documentUrl, opts.repo)) {
    return {
      kind: "unavailable",
      reason:
        `the \`${CONFIG_DIFF_STATUS_CONTEXT}\` status on ${shortSha} points its target_url at a location this tool will not fetch ` +
        `(only api.github.com, raw.githubusercontent.com and github.com release downloads serving ${opts.repo} are read). This is an UNKNOWN.`,
    };
  }

  let document: string;
  try {
    const res = await fetchFn(documentUrl, {
      method: "GET",
      headers: documentUrl.startsWith(`${apiBase}/`) ? headers : { accept: "application/octet-stream" },
    });
    if (!res.ok) {
      return { kind: "unavailable", reason: `the facts document at ${documentUrl} could not be fetched: ${res.status} ${await safeText(res)}` };
    }
    document = await res.text();
  } catch (err) {
    return { kind: "unavailable", reason: `the facts document at ${documentUrl} could not be fetched: ${errText(err)}` };
  }

  if (Buffer.byteLength(document, "utf8") > MAX_FACTS_DOCUMENT_BYTES) {
    return { kind: "unavailable", reason: `the facts document at ${documentUrl} is over the ${MAX_FACTS_DOCUMENT_BYTES}-byte cap — refusing to read it` };
  }

  const actual = configFactsDigest(document);
  if (actual !== named.digest) {
    return {
      kind: "unavailable",
      reason:
        `the document at ${documentUrl} hashes to sha256:${actual}, but the \`${CONFIG_DIFF_STATUS_CONTEXT}\` status on ${shortSha} ` +
        `vouches for sha256:${named.digest}. The bytes are NOT the ones a principal vouched for, so they are refused. This is an UNKNOWN.`,
    };
  }

  const parsed = parseConfigFacts(document);
  if (!parsed.ok) {
    return { kind: "unavailable", reason: `the vouched document at ${documentUrl} could not be read as a config-diff report: ${parsed.reason}` };
  }

  return {
    kind: "cloud-status",
    facts: parsed.facts,
    provenance: {
      repo: opts.repo,
      headSha: opts.headSha,
      statusContext: CONFIG_DIFF_STATUS_CONTEXT,
      digest: named.digest,
      documentUrl,
      sessionId: named.sessionId,
      postedAtIso: status.updated_at ?? status.created_at,
      postedBy: status.creator?.login,
    },
  };
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "(no body)";
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
