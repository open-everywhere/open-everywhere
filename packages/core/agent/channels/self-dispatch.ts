import type { RouteHandlerArgs } from "eve/channels";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../webhooks/gate.js";
import { getConfig } from "../access/config.js";
import { windowedSupervisorEnabled } from "../memory/domain.js";
import { isUnifiedSupervisorToken } from "./unified-supervisor.js";
import { isUnifiedWakeOrigin, type UnifiedWindowWake } from "./unified-window.js";
import { parseWindowToken, dmAnchorSurfaceForToken } from "./window-key.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { postOnce, outboundKey } from "../operational/post-once.js";
import { getOrMintSelfSecret, selfSecretsArmed } from "../credentials/self-secrets.js";

const SPAWN_DISPATCH_SECRET_ENV = "OE_SPAWN_DISPATCH_SECRET";

export const SELF_DISPATCH_PATH = "/eve/v1/unified/dispatch";

export const SELF_DISPATCH_SIGNATURE_HEADER = "x-oe-dispatch-signature";

export const SELF_DISPATCH_MAX_BODY_BYTES = 512 * 1024;

const SELF_DISPATCH_MAX_SKEW_MS = 5 * 60 * 1000;

export const SELF_DISPATCH_TIMEOUT_MS = 15_000;

export const SELF_DISPATCH_ATTEMPTS = 2;

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
  return selfSecretsArmed() && selfDispatchBaseUrl(env) !== undefined;
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

export type SelfDispatchDivert = (to: RouteHandlerArgs["to"], input: UnifiedDispatchPayload) => Promise<void>;

export async function readCappedBody(req: Request, maxBytes: number): Promise<{ body: string } | { tooLarge: true }> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return { tooLarge: true };
  }
  const stream = req.body;
  if (!stream) {
    const body = await req.text();
    return Buffer.byteLength(body, "utf8") > maxBytes ? { tooLarge: true } : { body };
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }
  return { body: Buffer.concat(chunks).toString("utf8") };
}

export async function handleSelfDispatch(
  req: Request,
  to: RouteHandlerArgs["to"],
  divert: SelfDispatchDivert,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  if (!selfSecretsArmed()) return new Response("not found", { status: 404 });

  const read = await readCappedBody(req, SELF_DISPATCH_MAX_BODY_BYTES);
  if ("tooLarge" in read) {
    return json(413, { error: `payload exceeds ${SELF_DISPATCH_MAX_BODY_BYTES} bytes` });
  }
  const rawBody = read.body;

  const secret = await getOrMintSelfSecret(SPAWN_DISPATCH_SECRET_ENV, { env });
  if (!verifyWebhookSignature(secret, rawBody, req.headers.get(SELF_DISPATCH_SIGNATURE_HEADER))) {
    return json(401, { error: "unauthorized: missing or invalid dispatch signature" });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const issuedAt = (decoded as { issuedAt?: unknown } | null)?.issuedAt;
  if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > SELF_DISPATCH_MAX_SKEW_MS) {
    return json(401, { error: "unauthorized: missing or stale dispatch timestamp" });
  }

  const parsed = parseSelfDispatchPayload(decoded);
  if ("error" in parsed) return json(400, { error: parsed.error });
  const payload = parsed.payload;

  let windowOk = false;
  try {
    const dmAnchorSurface = dmAnchorSurfaceForToken(payload.token);
    if (dmAnchorSurface !== undefined) {
      windowOk = dmAnchorSurface === payload.surfaceKey;
    } else {
      const domains = getConfig().loadDomains();
      windowOk = windowedSupervisorEnabled(payload.surfaceKey, domains);
    }
  } catch {
    windowOk = false;
  }
  if (!windowOk) {
    return json(400, { error: `no standing window (mode solo / unified) is enabled for surfaceKey "${payload.surfaceKey}" — refusing (fail-closed)` });
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

  const hopKey = outboundKey({ surface: "unified", channel: payload.surfaceKey, action: "self-dispatch", payload: rawBody });
  try {
    const outcome = await postOnce<"dispatched" | "deduped">({
      org,
      key: hopKey,
      ttlMs: SELF_DISPATCH_MAX_SKEW_MS,
      run: async () => {
        await divert(to, payload);
        return "dispatched";
      },
      skipped: () => "deduped",
    });
    return json(200, { ok: true, wakeId: payload.window.wakeId, ...(outcome === "deduped" ? { deduped: true } : {}) });
  } catch (err) {
    return json(500, { error: `dispatch failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export async function postSelfDispatch(
  payload: UnifiedDispatchPayload,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const base = selfDispatchBaseUrl(env);
  if (!base || !selfSecretsArmed()) {
    throw new Error(
      "self-dispatch is not configured on this deployment — arm OE_CREDENTIAL_ENCRYPTION_KEY (and set OE_PUBLIC_BASE_URL when the deployment URL isn't discoverable from VERCEL_URL/VERCEL_PROJECT_PRODUCTION_URL).",
    );
  }
  const secret = await getOrMintSelfSecret(SPAWN_DISPATCH_SECRET_ENV, { env });
  const body = JSON.stringify({ ...payload, issuedAt: Date.now() });
  const url = `${base}${SELF_DISPATCH_PATH}`;
  const headers = { "content-type": "application/json", [SELF_DISPATCH_SIGNATURE_HEADER]: signSelfDispatchBody(secret, body) };
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? SELF_DISPATCH_TIMEOUT_MS;

  let lastErr: unknown;
  for (let attempt = 0; attempt < SELF_DISPATCH_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`self-dispatch POST to ${url} returned ${res.status}: ${text.slice(0, 200)}`);
    }
    return;
  }
  throw new Error(`self-dispatch POST to ${url} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
