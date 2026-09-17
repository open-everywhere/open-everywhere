import type { BindableContext, SurfaceBinding } from "./binding.js";

export const OE_FROZEN_SURFACE_BINDING_ATTR = "oe_frozen_surface_binding";

export function isFrozenSurfaceBinding(value: unknown): value is SurfaceBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  const allowed = new Set([
    "org",
    "platform",
    "workspace",
    "surface",
    "domainSurface",
    "mode",
    "visibility",
    "trust",
    "declaredTrust",
    "principalId",
    "principalAttested",
    "target",
    "threadTs",
    "engagementKey",
    "roomEngagementKey",
    "anchorMessageId",
    "anchorChannelId",
  ]);
  if (Object.keys(b).some((key) => !allowed.has(key))) return false;
  for (const key of ["org", "platform", "workspace", "surface"] as const) {
    if (typeof b[key] !== "string" || b[key].length === 0) return false;
  }
  if (b.mode !== "channel" && b.mode !== "dm" && b.mode !== "mpim") return false;
  if (b.visibility !== "public" && b.visibility !== "private") return false;
  if (b.trust !== "internal" && b.trust !== "external") return false;
  if (b.declaredTrust !== undefined && b.declaredTrust !== "internal" && b.declaredTrust !== "public") return false;
  if (b.principalAttested !== undefined && b.principalAttested !== true) return false;
  for (const key of ["domainSurface", "principalId", "threadTs", "engagementKey", "roomEngagementKey", "anchorMessageId", "anchorChannelId"] as const) {
    if (b[key] !== undefined && (typeof b[key] !== "string" || b[key].length === 0)) return false;
  }
  if (b.target !== undefined) {
    if (b.target === null || typeof b.target !== "object" || Array.isArray(b.target)) return false;
    const target = b.target as Record<string, unknown>;
    const allowedTargetKeys: Readonly<Record<string, ReadonlySet<string>>> = {
      slack: new Set(["channelId"]),
      discord: new Set(["channelId", "guildId", "channelType"]),
      notion: new Set(["discussionId", "pageId", "credentialId"]),
      linear: new Set(["agentSessionId", "issueId", "parentId", "organizationId"]),
      teams: new Set(["serviceUrl", "conversationId", "tenantId", "channelId", "teamId", "conversationType", "aadObjectId"]),
      github: new Set(["owner", "repo", "issueNumber", "pullRequestNumber", "installationId"]),
    };
    const keys = allowedTargetKeys[String(b.platform)];
    if (
      keys === undefined ||
      Object.keys(target).some((key) => !keys.has(key)) ||
      Object.values(target).some((v) => v !== undefined && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
    )
      return false;
  }
  return true;
}

export function frozenSurfaceBindingFrom(ctx: BindableContext): SurfaceBinding | undefined {
  try {
    const raw = ctx.session?.auth?.current?.attributes?.[OE_FROZEN_SURFACE_BINDING_ATTR];
    const text = Array.isArray(raw) ? raw[0] : raw;
    if (typeof text !== "string" || text.length === 0 || text.length > 16_384) return undefined;
    const parsed: unknown = JSON.parse(text);
    return isFrozenSurfaceBinding(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
