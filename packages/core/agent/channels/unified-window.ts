import { randomUUID } from "node:crypto";

export type UnifiedWakeOrigin =
  | {
      readonly platform: "slack";
      readonly channelId: string;
      readonly threadTs?: string;
    }
  | {
      readonly platform: "github";
      readonly owner: string;
      readonly repo: string;
      readonly issueNumber: number;
      readonly installationId?: number;
    }
  | {
      readonly platform: "linear";
      readonly issueId: string;
      readonly parentId?: string;
    };

export const WAKE_TARGET_TTL_MS = 6 * 60 * 60 * 1000;

export function mintWakeId(): string {
  return randomUUID();
}

export interface UnifiedWakeTargetStore {
  putUnifiedWakeTarget(org: string, wakeId: string, targetJson: string, at: string, ttlMs: number): Promise<void>;
  getUnifiedWakeTarget(org: string, wakeId: string): Promise<string | null>;
}

export async function registerUnifiedWakeTarget(
  store: UnifiedWakeTargetStore,
  org: string,
  wakeId: string,
  origin: UnifiedWakeOrigin,
  atIso: string,
): Promise<void> {
  await store.putUnifiedWakeTarget(org, wakeId, JSON.stringify(origin), atIso, WAKE_TARGET_TTL_MS);
}

export async function resolveUnifiedWakeTarget(store: UnifiedWakeTargetStore, org: string, wakeId: string): Promise<UnifiedWakeOrigin | null> {
  if (typeof wakeId !== "string" || wakeId.length === 0 || wakeId.length > 200) return null;
  let json: string | null;
  try {
    json = await store.getUnifiedWakeTarget(org, wakeId);
  } catch {
    return null;
  }
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return isUnifiedWakeOrigin(parsed) ? parsed : null;
}

export function isUnifiedWakeOrigin(v: unknown): v is UnifiedWakeOrigin {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  if (o.platform === "slack") {
    return typeof o.channelId === "string" && o.channelId.length > 0 && (o.threadTs === undefined || typeof o.threadTs === "string");
  }
  if (o.platform === "github") {
    return (
      typeof o.owner === "string" &&
      o.owner.length > 0 &&
      typeof o.repo === "string" &&
      o.repo.length > 0 &&
      typeof o.issueNumber === "number" &&
      Number.isFinite(o.issueNumber) &&
      o.issueNumber > 0 &&
      (o.installationId === undefined || typeof o.installationId === "number")
    );
  }
  if (o.platform === "linear") {
    return typeof o.issueId === "string" && o.issueId.length > 0 && (o.parentId === undefined || typeof o.parentId === "string");
  }
  return false;
}

export const OE_PLATFORM_ATTR = "oe_platform";
export const OE_WAKE_ID_ATTR = "oe_wake_id";
export const OE_ADDRESSING_ATTR = "oe_addressing";

export function stampUnifiedWindowAuth<A extends { attributes?: Record<string, unknown> }>(
  auth: A,
  platform: UnifiedWakeOrigin["platform"],
  wakeId: string,
  addressing?: "direct-mention",
): A {
  return {
    ...auth,
    attributes: {
      ...(auth.attributes ?? {}),
      [OE_PLATFORM_ATTR]: platform,
      [OE_WAKE_ID_ATTR]: wakeId,
      ...(addressing ? { [OE_ADDRESSING_ATTR]: addressing } : {}),
    },
  };
}

export function shouldBridgeAddressedProse(addressing: string | undefined, alreadyReplied: boolean): boolean {
  return addressing === "direct-mention" && !alreadyReplied;
}

export interface UnifiedWindowWake {
  readonly wakeId: string;
  readonly origin: UnifiedWakeOrigin;
  readonly addressing?: "direct-mention";
}
