import { createHmac, timingSafeEqual } from "node:crypto";
import { operatorSecretOrUnset } from "@open-everywhere/core/agent/adapter-api.js";
import { linearAppForOrg, primaryLinearOrganizationId } from "./linear-credentials.js";

const LINEAR_WEBHOOK_SECRET_NAME = "LINEAR_WEBHOOK_SECRET";

export const LINEAR_SIGNATURE_HEADER = "linear-signature";

export const LINEAR_MAX_SKEW_MS = 60_000;

export function signLinearWebhookBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function linearWebhookSecretForOrg(
  organizationId: string | undefined,
  primarySecret: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const app = linearAppForOrg(organizationId, env);
  if (app) return app.webhookSecret;
  const primaryOrg = primaryLinearOrganizationId();
  if (organizationId && primaryOrg && organizationId !== primaryOrg) return undefined;
  return primarySecret && primarySecret.length > 0 ? primarySecret : undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function verifyLinearWebhookDelivery(
  headers: Headers,
  body: string,
  opts: { readonly primarySecret?: string; readonly env?: NodeJS.ProcessEnv; readonly nowMs?: number; readonly maxSkewMs?: number } = {},
): boolean {
  const env = opts.env ?? process.env;
  const signature = headers.get(LINEAR_SIGNATURE_HEADER) ?? "";
  if (!signature) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof payload !== "object" || payload === null) return false;
  const organizationId = (payload as { organizationId?: unknown }).organizationId;
  const secret = linearWebhookSecretForOrg(typeof organizationId === "string" && organizationId.length > 0 ? organizationId : undefined, opts.primarySecret, env);
  if (!secret) return false;
  if (!constantTimeEquals(signLinearWebhookBody(body, secret), signature)) return false;
  const timestamp = (payload as { webhookTimestamp?: unknown }).webhookTimestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return false;
  const skew = opts.maxSkewMs ?? LINEAR_MAX_SKEW_MS;
  return Math.abs((opts.nowMs ?? Date.now()) - timestamp) <= skew;
}

export async function linearWebhookVerifier(req: Request, body: string): Promise<boolean> {
  return verifyLinearWebhookDelivery(req.headers, body, { primarySecret: await linearPrimaryWebhookSecret() });
}

export async function linearPrimaryWebhookSecret(): Promise<string | undefined> {
  return await operatorSecretOrUnset(LINEAR_WEBHOOK_SECRET_NAME);
}
