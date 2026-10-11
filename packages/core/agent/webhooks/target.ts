import { isQualifiedPrincipalKey, parsePrincipalKey } from "../identity/principal-key.js";
import type { DeclaredTargetSpec } from "../schedules/routine-dispatch.js";

export const WEBHOOK_DM_TARGET_PREFIX = "dm:";

const WEBHOOK_TARGET_PLATFORMS: readonly string[] = ["slack", "discord", "teams"];

const SEGMENT = /^[^/\s]+$/u;

export function parseWebhookTarget(target: string): { readonly spec: DeclaredTargetSpec } | { readonly defect: string } {
  const forms =
    `name a room as "<platform>/<workspace>/<surface>" (for example "slack/T0123ABC/C0123ABC") or a person's DM as ` +
    `"dm:<principal key>" (for example "dm:slack/T0123ABC/U0123ABC", "dm:discord/300000000000000104"), on ${WEBHOOK_TARGET_PLATFORMS.join(", ")}`;
  if (target.startsWith(WEBHOOK_DM_TARGET_PREFIX)) {
    const key = target.slice(WEBHOOK_DM_TARGET_PREFIX.length);
    const parsed = isQualifiedPrincipalKey(key) ? parsePrincipalKey(key) : undefined;
    if (!parsed) return { defect: `${JSON.stringify(target)} is not a person target — after "dm:" comes a qualified principal key; ${forms}` };
    if (!WEBHOOK_TARGET_PLATFORMS.includes(parsed.platform)) {
      return { defect: `${JSON.stringify(target)} names platform "${parsed.platform}", which has no webhook target resolver; ${forms}` };
    }
    return {
      spec: { kind: "person", platform: parsed.platform, principalId: parsed.id, ...(parsed.tenant !== undefined ? { tenant: parsed.tenant } : {}) },
    };
  }
  const parts = target.split("/");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) {
    return { defect: `${JSON.stringify(target)} is not a fully-qualified target; ${forms}` };
  }
  const [platform, workspace, surface] = parts as [string, string, string];
  if (!WEBHOOK_TARGET_PLATFORMS.includes(platform)) {
    return { defect: `${JSON.stringify(target)} names platform "${platform}", which has no webhook target resolver; ${forms}` };
  }
  return { spec: { kind: "room", platform, workspace, surface } };
}

export function webhookTargetPlatform(target: string | undefined): string | undefined {
  if (target === undefined) return undefined;
  const parsed = parseWebhookTarget(target);
  return "spec" in parsed ? parsed.spec.platform : undefined;
}
