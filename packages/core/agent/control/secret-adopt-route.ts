import { routeAuth } from "eve/channels/auth";
import { injectTokenAuth, injectTokenEntries } from "./auth.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { ENV_ADOPT_MAX_NAMES, runEnvAdoptDoor } from "../credentials/env-adopt.js";

export const CONTROL_SECRET_ADOPT_PATH = "/control/v1/secrets/adopt";

export interface SecretAdoptRequest {
  readonly names: readonly string[];
  readonly overwrite?: boolean;
  readonly org?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bodyRefusal(body: unknown, org: string): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "the body must be a JSON object: { names, overwrite?, org? }";
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.names)) return "`names` must be an array of operator-secret names";
  if (b.names.length === 0) return "name at least one operator secret to adopt";
  if (b.names.length > ENV_ADOPT_MAX_NAMES) return `${b.names.length} names — the limit is ${ENV_ADOPT_MAX_NAMES} per call`;
  const bad = b.names.findIndex((n) => typeof n !== "string");
  if (bad >= 0) return `names[${bad}] must be a string`;
  if (b.overwrite !== undefined && typeof b.overwrite !== "boolean") return "`overwrite` must be a boolean";
  if (b.org !== undefined && b.org !== org) return "forbidden: `org` is not this deployment's org";
  return undefined;
}

export async function handleSecretAdopt(req: Request): Promise<Response> {
  const entries = await injectTokenEntries();
  if (entries.length === 0) return new Response("not found", { status: 404 });
  const identity = await routeAuth(req, injectTokenAuth(entries));
  if (identity instanceof Response) return identity;
  const org = deploymentOrg();
  await appendAudit({
    org,
    platform: "control",
    workspace: "control",
    principalId: identity.principalId,
    action: "control.service_call",
    detail: { service: identity.principalId, view: "secret_adopt" },
  });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid JSON body" });
  }
  const refusal = bodyRefusal(body, org);
  if (refusal) return json(400, { ok: false, error: refusal });
  const { names, overwrite } = body as SecretAdoptRequest;

  const outcome = await runEnvAdoptDoor({ names, overwrite: overwrite === true, actor: identity.principalId, org });
  if (!outcome.ok) return json(outcome.refused ? 400 : 500, { ok: false, error: `adopt_env_secrets failed: ${outcome.message}` });
  return json(200, { ok: true, org, overwrite: overwrite === true, results: outcome.results });
}
