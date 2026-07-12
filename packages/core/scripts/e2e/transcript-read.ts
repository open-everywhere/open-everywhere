export interface TranscriptWireEvent {
  readonly index: number;
  readonly at: string | null;
  readonly type: string;
  readonly data: unknown;
}

export interface TranscriptResult {
  readonly sessionId: string;
  readonly startIndex: number;
  readonly nextIndex: number;
  readonly complete: boolean;
  readonly count: number;
  readonly events: readonly TranscriptWireEvent[];
}

export interface TranscriptQueryOpts {
  readonly startIndex?: number;
  readonly limit?: number;
  readonly idleMs?: number;
}

export function buildTranscriptQuery(opts: TranscriptQueryOpts): string {
  const params = new URLSearchParams();
  if (opts.startIndex !== undefined) params.set("startIndex", String(opts.startIndex));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.idleMs !== undefined) params.set("idleMs", String(opts.idleMs));
  return params.toString();
}

export function transcriptPath(sessionId: string, opts: TranscriptQueryOpts = {}): string {
  const qs = buildTranscriptQuery(opts);
  return `/control/v1/session/${encodeURIComponent(sessionId)}/transcript${qs ? `?${qs}` : ""}`;
}

export async function fetchTranscript(
  targetUrl: string,
  readToken: string,
  sessionId: string,
  opts: TranscriptQueryOpts = {},
): Promise<TranscriptResult> {
  const base = targetUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}${transcriptPath(sessionId, opts)}`, {
    headers: { authorization: `Bearer ${readToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`GET /control/v1/session/${sessionId}/transcript → ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  const parsed = (await res.json()) as Partial<TranscriptResult>;
  if (!Array.isArray(parsed.events)) throw new Error("transcript response has no events array (malformed response)");
  return parsed as TranscriptResult;
}

export function findEvents(
  events: readonly TranscriptWireEvent[],
  type: string,
  where?: (e: TranscriptWireEvent) => boolean,
): readonly TranscriptWireEvent[] {
  return events.filter((e) => e.type === type && (where === undefined || where(e)));
}
