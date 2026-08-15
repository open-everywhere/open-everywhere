import { resolveTeamsAppId } from "eve/channels/teams";
import type { BotDisplayNameArm } from "@open-everywhere/core/agent/adapter-api.js";
import { liveTeamsGraphRequest, type TeamsGraphRequester } from "./teams-read.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphNamedObject {
  readonly displayName?: unknown;
}

export async function teamsBotDisplayNameViaGraph(appId: string, req: TeamsGraphRequester): Promise<string | undefined> {
  if (appId.length === 0) return undefined;
  try {
    const json = (await req(`${GRAPH_BASE}/servicePrincipals(appId='${encodeURIComponent(appId)}')?$select=displayName`)) as GraphNamedObject | null;
    const name = json?.displayName;
    if (typeof name !== "string") return undefined;
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

let displayNamePromise: Promise<string | undefined> | undefined;

export const teamsBotDisplayName: BotDisplayNameArm = () => {
  if (!displayNamePromise) {
    displayNamePromise = (async () => {
      try {
        const timeout = new Promise<undefined>((resolve) => {
          const t = setTimeout(() => resolve(undefined), 5000);
          t.unref?.();
        });
        return await Promise.race([teamsBotDisplayNameViaGraph(await resolveTeamsAppId(), liveTeamsGraphRequest), timeout]);
      } catch {
        return undefined;
      }
    })();
  }
  return displayNamePromise;
};

export function _resetTeamsBotDisplayNameForTest(): void {
  displayNamePromise = undefined;
}
