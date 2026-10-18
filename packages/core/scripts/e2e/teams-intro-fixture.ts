import type { Partition } from "../../agent/memory/partition.js";
import type { MemoryProvider } from "../../agent/memory/provider.js";
import type { OperationalStore } from "../../agent/operational/store.js";
import { SURFACE } from "../../agent/memory/store.js";
import { ONBOARDED_MARKER } from "../../agent/onboarding/onboarding.js";
import { seg } from "../../agent/identity/deployment-identity.js";
import { UNNAMED_TENANT } from "../../agent/identity/principal-key.js";

export function teamsIntroMarkerPartition(args: { readonly org: string; readonly tenantId: string; readonly channelId: string }): Partition {
  const workspace = seg(args.tenantId, UNNAMED_TENANT);
  const surface = seg(args.channelId, "default");
  const workspaceKey = `teams/${workspace}`;
  const surfaceKey = `${workspaceKey}/${surface}`;
  return { org: args.org, platform: "teams", workspace, surface, workspaceKey, surfaceKey, domainKey: surfaceKey, key: surfaceKey };
}

export function teamsIntroClaimKey(p: Pick<Partition, "surfaceKey">): string {
  return `teams-intro:${p.surfaceKey}`;
}

export interface TeamsIntroReset {
  readonly markerBefore: string | undefined;
  readonly markerRemains: boolean;
}

export async function resetTeamsIntroMarker(
  deps: {
    readonly memory: Pick<MemoryProvider, "readTier" | "deleteFile">;
    readonly store: Pick<OperationalStore, "forgetEventSeen">;
  },
  p: Partition,
): Promise<TeamsIntroReset> {
  const deleteFile = deps.memory.deleteFile;
  if (deleteFile === undefined) throw new Error("the memory provider has no per-file delete, so the intro marker cannot be cleared");
  const markerBefore = (await deps.memory.readTier(p, SURFACE))[ONBOARDED_MARKER];
  if (markerBefore !== undefined) await deleteFile.call(deps.memory, p, SURFACE, ONBOARDED_MARKER);
  await deps.store.forgetEventSeen(p.org, teamsIntroClaimKey(p));
  const markerRemains = (await deps.memory.readTier(p, SURFACE))[ONBOARDED_MARKER] !== undefined;
  return { markerBefore, markerRemains };
}
