import { signLinearWebhookBody } from "eve/channels/linear";
import { timingSafeEqual } from "node:crypto";
import { linearAppForOrg, primaryLinearOrganizationId } from "./linear-credentials.js";

export const LINEAR_SIGNATURE_HEADER = "linear-signature";

export const LINEAR_MAX_SKEW_MS = 60_000;

export function linearWebhookSecretForOrg(organizationId: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const app = linearAppForOrg(organizationId, env);
  if (app) return app.webhookSecret;
  const primaryOrg = env.LINEAR_ORGANIZATION_ID && env.LINEAR_ORGANIZATION_ID.length > 0 ? env.LINEAR_ORGANIZATION_ID : undefined;
  if (organizationId && primaryOrg && organizationId !== primaryOrg) return undefined;
  const secret = env.LINEAR_WEBHOOK_SECRET;
  return secret && secret.length > 0 ? secret : undefined;
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
  opts: { readonly env?: NodeJS.ProcessEnv; readonly nowMs?: number; readonly maxSkewMs?: number } = {},
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
  const secret = linearWebhookSecretForOrg(typeof organizationId === "string" && organizationId.length > 0 ? organizationId : undefined, env);
  if (!secret) return false;
  if (!constantTimeEquals(signLinearWebhookBody(body, secret), signature)) return false;
  const timestamp = (payload as { webhookTimestamp?: unknown }).webhookTimestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return false;
  const skew = opts.maxSkewMs ?? LINEAR_MAX_SKEW_MS;
  return Math.abs((opts.nowMs ?? Date.now()) - timestamp) <= skew;
}

export async function linearWebhookVerifier(req: Request, body: string): Promise<boolean> {
  return verifyLinearWebhookDelivery(req.headers, body);
}
