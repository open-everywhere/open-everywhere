import type { RouteHandlerArgs } from "eve/channels";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../webhooks/gate.js";
import { getConfig } from "../access/config.js";
import { crossSurfaceWindowEnabled } from "../memory/domain.js";
import { isUnifiedSupervisorToken } from "./unified-supervisor.js";
import { isUnifiedWakeOrigin, type UnifiedWindowWake } from "./unified-window.js";
import { parseWindowToken } from "./window-key.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";

export const SELF_DISPATCH_PATH = "/eve/v1/unified/dispatch";

export const SELF_DISPATCH_SIGNATURE_HEADER = "x-oe-dispatch-signature";

export const SELF_DISPATCH_MAX_BODY_BYTES = 512 * 1024;

export interface UnifiedDispatchPayload {
  readonly message: string;
  readonly context?: readonly string[];
  readonly token: string;
  readonly window: UnifiedWindowWake;
  readonly surfaceKey: string;
  readonly auth: { attributes?: Record<string, unknown> };
  readonly excludeTaskResultId?: string;
}

export function selfDispatchSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = (env.OE_SPAWN_DISPATCH_SECRET ?? "").trim();
  return v.length > 0 ? v : undefined;
}

export function selfDispatchBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = (env.OE_PUBLIC_BASE_URL ?? "").trim();
  if (explicit.length > 0) {
    const withScheme = /^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`;
    return withScheme.replace(/\/+$/, "");
  }
  const host = (env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim() || (env.VERCEL_URL ?? "").trim();
  return host.length > 0 ? `https://${host.replace(/\/+$/, "")}` : undefined;
}

export function selfDispatchConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return selfDispatchSecret(env) !== undefined && selfDispatchBaseUrl(env) !== undefined;
}

export function signSelfDispatchBody(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function parseSelfDispatchPayload(v: unknown): { payload: UnifiedDispatchPayload } | { error: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { error: "body must be a JSON object" };
  const b = v as Record<string, unknown>;
  if (typeof b.message !== "string" || b.message.length === 0) return { error: "`message` must be a non-empty string" };
  if (b.context !== undefined && (!Array.isArray(b.context) || !b.context.every((c) => typeof c === "string"))) {
    return { error: "`context` must be an array of strings when present" };
  }
  if (typeof b.token !== "string" || !isUnifiedSupervisorToken(b.token)) {
    return { error: "`token` must be a unified-supervisor window token" };
  }
  if (typeof b.surfaceKey !== "string" || b.surfaceKey.length === 0) return { error: "`surfaceKey` must be a non-empty string" };
  const w = b.window as Record<string, unknown> | undefined;
  if (typeof w !== "object" || w === null) return { error: "`window` must be an object" };
  if (typeof w.wakeId !== "string" || w.wakeId.length === 0) return { error: "`window.wakeId` must be a non-empty string" };
  if (!isUnifiedWakeOrigin(w.origin)) return { error: "`window.origin` must be a valid UnifiedWakeOrigin" };
  if (w.addressing !== undefined && w.addressing !== "direct-mention") {
    return { error: '`window.addressing` must be "direct-mention" or absent' };
  }
  const auth = b.auth as Record<string, unknown> | undefined;
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return { error: "`auth` must be an object" };
  if (auth.attributes !== undefined && (typeof auth.attributes !== "object" || auth.attributes === null || Array.isArray(auth.attributes))) {
    return { error: "`auth.attributes` must be a plain object when present" };
  }
  if (b.excludeTaskResultId !== undefined && (typeof b.excludeTaskResultId !== "string" || b.excludeTaskResultId.length === 0)) {
    return { error: "`excludeTaskResultId` must be a non-empty string when present" };
  }
  return {
    payload: {
      message: b.message,
      ...(b.context !== undefined ? { context: b.context as string[] } : {}),
      token: b.token,
      window: {
        wakeId: w.wakeId,
        origin: w.origin,
        ...(w.addressing === "direct-mention" ? { addressing: "direct-mention" as const } : {}),
      },
      surfaceKey: b.surfaceKey,
      auth: { ...(auth.attributes !== undefined ? { attributes: auth.attributes as Record<string, unknown> } : {}) },
      ...(b.excludeTaskResultId !== undefined ? { excludeTaskResultId: b.excludeTaskResultId } : {}),
    },
  };
}

export type SelfDispatchDivert = (receive: RouteHandlerArgs["receive"], input: UnifiedDispatchPayload) => Promise<void>;

export async function handleSelfDispatch(
  req: Request,
  receive: RouteHandlerArgs["receive"],
  divert: SelfDispatchDivert,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const secret = selfDispatchSecret(env);
  if (!secret) return new Response("not found", { status: 404 });

  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > SELF_DISPATCH_MAX_BODY_BYTES) {
    return json(413, { error: `payload exceeds ${SELF_DISPATCH_MAX_BODY_BYTES} bytes` });
  }

  if (!verifyWebhookSignature(secret, rawBody, req.headers.get(SELF_DISPATCH_SIGNATURE_HEADER))) {
    return json(401, { error: "unauthorized: missing or invalid dispatch signature" });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const parsed = parseSelfDispatchPayload(decoded);
  if ("error" in parsed) return json(400, { error: parsed.error });
  const payload = parsed.payload;

  let windowOk = false;
  try {
    windowOk = crossSurfaceWindowEnabled(payload.surfaceKey, getConfig().loadDomains());
  } catch {
    windowOk = false;
  }
  if (!windowOk) {
    return json(400, { error: `crossSurfaceWindow is not enabled for surfaceKey "${payload.surfaceKey}" — refusing (fail-closed)` });
  }

  const org = deploymentOrg();
  await appendAudit({
    org,
    platform: "unified",
    workspace: parseWindowToken(payload.token)?.domain ?? "unknown",
    action: "unified.self_dispatch",
    detail: {
      wakeId: payload.window.wakeId,
      surfaceKey: payload.surfaceKey,
      platform: payload.window.origin.platform,
      addressed: payload.window.addressing === "direct-mention",
      messageChars: payload.message.length,
      ...(payload.excludeTaskResultId ? { excludeTaskResultId: payload.excludeTaskResultId } : {}),
    },
  }).catch(() => undefined);

  try {
    await divert(receive, payload);
  } catch (err) {
    return json(500, { error: `dispatch failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  return json(200, { ok: true, wakeId: payload.window.wakeId });
}

export async function postSelfDispatch(
  payload: UnifiedDispatchPayload,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const secret = selfDispatchSecret(env);
  const base = selfDispatchBaseUrl(env);
  if (!secret || !base) {
    throw new Error(
      "self-dispatch is not configured on this deployment — set OE_SPAWN_DISPATCH_SECRET (and OE_PUBLIC_BASE_URL when the deployment URL isn't discoverable from VERCEL_URL/VERCEL_PROJECT_PRODUCTION_URL).",
    );
  }
  const body = JSON.stringify(payload);
  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}${SELF_DISPATCH_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [SELF_DISPATCH_SIGNATURE_HEADER]: signSelfDispatchBody(secret, body) },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new Error(`self-dispatch POST to ${base}${SELF_DISPATCH_PATH} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`self-dispatch POST to ${base}${SELF_DISPATCH_PATH} returned ${res.status}: ${text.slice(0, 200)}`);
  }
}
