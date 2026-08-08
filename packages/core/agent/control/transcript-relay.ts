import type { AttachSessionFn } from "eve/channels";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../webhooks/gate.js";
import { readCappedBody, selfDispatchBaseUrl } from "../channels/self-dispatch.js";
import { drainSessionStream, probeSessionExists, type ProbeableSession, type SourceStreamEvent } from "./read-route.js";
import { renderTranscript } from "./transcript-render.js";
import { listRoutineFires } from "../routines/fire-audit.js";
import { appendAudit } from "../audit/audit.js";

export const TRANSCRIPT_RELAY_PATH = "/eve/v1/internal/transcript";

export const TRANSCRIPT_RELAY_SIGNATURE_HEADER = "x-oe-transcript-signature";

export const TRANSCRIPT_RELAY_MAX_BODY_BYTES = 16 * 1024;

export const TRANSCRIPT_RELAY_MAX_SKEW_MS = 5 * 60 * 1000;

export const TRANSCRIPT_RELAY_TIMEOUT_MS = 20_000;

export const TRANSCRIPT_RELAY_MAX_EVENTS = 600;

export const TRANSCRIPT_RELAY_IDLE_MS = 1500;

export const TRANSCRIPT_RELAY_PROBE_MS = 3000;

export const TRANSCRIPT_RELAY_MAX_FIRE_DEPTH = 10;

export interface TranscriptRelayRequest {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly routineId: string;
  readonly fireDepth: number;
}

export interface TranscriptRelayResult {
  readonly routineId: string;
  readonly sessionId: string;
  readonly firedAt: string;
  readonly outcome: string | null;
  readonly silent: boolean;
  readonly firesAvailable: number;
  readonly eventCount: number;
  readonly complete: boolean;
  readonly text: string;
}

export function transcriptRelaySecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = (env.OE_TRANSCRIPT_RELAY_SECRET ?? "").trim();
  return v.length > 0 ? v : undefined;
}

export function transcriptRelayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return transcriptRelaySecret(env) !== undefined && selfDispatchBaseUrl(env) !== undefined;
}

export function signTranscriptRelayBody(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function parseTranscriptRelayRequest(v: unknown): { request: TranscriptRelayRequest } | { error: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { error: "body must be a JSON object" };
  const b = v as Record<string, unknown>;
  for (const key of ["org", "platform", "workspace", "routineId"] as const) {
    if (typeof b[key] !== "string" || (b[key] as string).length === 0) return { error: `\`${key}\` must be a non-empty string` };
  }
  if (typeof b.surface !== "string") return { error: "`surface` must be a string" };
  const depth = b.fireDepth;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > TRANSCRIPT_RELAY_MAX_FIRE_DEPTH) {
    return { error: `\`fireDepth\` must be an integer in 1..${TRANSCRIPT_RELAY_MAX_FIRE_DEPTH}` };
  }
  return {
    request: {
      org: b.org as string,
      platform: b.platform as string,
      workspace: b.workspace as string,
      surface: b.surface,
      routineId: b.routineId as string,
      fireDepth: depth,
    },
  };
}

export interface TranscriptRelayDeps {
  readonly fires?: typeof listRoutineFires;
  readonly env?: NodeJS.ProcessEnv;
}

export async function handleTranscriptRelay(
  req: Request,
  attachSession: AttachSessionFn,
  deps: TranscriptRelayDeps = {},
): Promise<Response> {
  const env = deps.env ?? process.env;
  const secret = transcriptRelaySecret(env);
  if (!secret) return new Response("not found", { status: 404 });

  const read = await readCappedBody(req, TRANSCRIPT_RELAY_MAX_BODY_BYTES);
  if ("tooLarge" in read) return json(413, { error: `payload exceeds ${TRANSCRIPT_RELAY_MAX_BODY_BYTES} bytes` });
  const rawBody = read.body;

  if (!verifyWebhookSignature(secret, rawBody, req.headers.get(TRANSCRIPT_RELAY_SIGNATURE_HEADER))) {
    return json(401, { error: "unauthorized: missing or invalid transcript signature" });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const issuedAt = (decoded as { issuedAt?: unknown } | null)?.issuedAt;
  if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > TRANSCRIPT_RELAY_MAX_SKEW_MS) {
    return json(401, { error: "unauthorized: missing or stale transcript timestamp" });
  }

  const parsed = parseTranscriptRelayRequest(decoded);
  if ("error" in parsed) return json(400, { error: parsed.error });
  const request = parsed.request;

  let fires: Awaited<ReturnType<typeof listRoutineFires>>;
  try {
    fires = await (deps.fires ?? listRoutineFires)(
      { org: request.org, platform: request.platform, workspace: request.workspace, surface: request.surface },
      request.routineId,
    );
  } catch (err) {
    return json(502, { error: `could not resolve the routine's run history: ${err instanceof Error ? err.message : String(err)}` });
  }
  const fire = fires[request.fireDepth - 1];
  if (fire === undefined) return new Response("not found", { status: 404 });

  await appendAudit({
    org: request.org,
    platform: request.platform,
    workspace: request.workspace,
    surface: request.surface,
    action: "routine.transcript_read",
    detail: { routineId: request.routineId, sessionId: fire.sessionId, fireDepth: request.fireDepth, firedAt: fire.at },
  }).catch(() => undefined);

  const session = attachSession(fire.sessionId);

  if ((await probeSessionExists(session as ProbeableSession, TRANSCRIPT_RELAY_PROBE_MS)) === "missing") {
    return json(410, { error: "that run's transcript is no longer available (expired or unreadable)" });
  }

  let stream: ReadableStream<SourceStreamEvent>;
  try {
    stream = (await session.getEventStream({ startIndex: 0 })) as unknown as ReadableStream<SourceStreamEvent>;
  } catch {
    return json(410, { error: "that run's transcript is no longer available (expired or unreadable)" });
  }

  try {
    const { events, complete } = await drainSessionStream(stream, 0, TRANSCRIPT_RELAY_MAX_EVENTS, TRANSCRIPT_RELAY_IDLE_MS);
    const text = renderTranscript(events, { complete, eventCount: events.length });
    const result: TranscriptRelayResult = {
      routineId: request.routineId,
      sessionId: fire.sessionId,
      firedAt: fire.at,
      outcome: fire.outcome,
      silent: fire.silent,
      firesAvailable: fires.length,
      eventCount: events.length,
      complete,
      text,
    };
    return json(200, result);
  } catch (err) {
    return json(502, { error: `transcript read failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export class TranscriptRelayError extends Error {}

export async function fetchRoutineTranscript(
  request: TranscriptRelayRequest,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<TranscriptRelayResult> {
  const env = deps.env ?? process.env;
  const secret = transcriptRelaySecret(env);
  const base = selfDispatchBaseUrl(env);
  if (!secret || !base) {
    throw new TranscriptRelayError(
      "transcript reading is not configured on this deployment — set OE_TRANSCRIPT_RELAY_SECRET (and OE_PUBLIC_BASE_URL when the deployment URL isn't discoverable from VERCEL_URL/VERCEL_PROJECT_PRODUCTION_URL).",
    );
  }
  const body = JSON.stringify({ ...request, issuedAt: Date.now() });
  const url = `${base}${TRANSCRIPT_RELAY_PATH}`;
  const res = await (deps.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json", [TRANSCRIPT_RELAY_SIGNATURE_HEADER]: signTranscriptRelayBody(secret, body) },
    body,
    signal: AbortSignal.timeout(deps.timeoutMs ?? TRANSCRIPT_RELAY_TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new TranscriptRelayError(`could not reach this deployment's transcript reader: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (res.status === 404) {
    throw new TranscriptRelayError(
      `no run of routine "${request.routineId}" is on record for this channel (it may belong to another channel, or its runs may be older than the 7-day run-history window).`,
    );
  }
  if (res.status === 410) {
    throw new TranscriptRelayError(`that run's transcript is no longer available — eve's durable stream for it has expired.`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new TranscriptRelayError(`transcript read returned ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  return (await res.json()) as TranscriptRelayResult;
}
