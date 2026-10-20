import { resolveTeamsAppId } from "eve/channels/teams";
import { teamsAppCredentials } from "./teams-connector.js";
import type { BotDisplayNameArm } from "@open-everywhere/core/agent/adapter-api.js";
import { liveTeamsGraphRequest, type TeamsGraphRequester } from "./teams-read.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphNamedObject {
  readonly displayName?: unknown;
}

interface GraphCatalogApp extends GraphNamedObject {
  readonly appDefinitions?: readonly GraphNamedObject[];
}

interface GraphCatalogPage {
  readonly value?: readonly GraphCatalogApp[];
}

function trimmedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function teamsBotDisplayNameViaGraph(appId: string, req: TeamsGraphRequester): Promise<string | undefined> {
  if (appId.length === 0) return undefined;
  try {
    const json = (await req(`${GRAPH_BASE}/servicePrincipals(appId='${encodeURIComponent(appId)}')?$select=displayName`)) as GraphNamedObject | null;
    return trimmedName(json?.displayName);
  } catch {
    return undefined;
  }
}

export async function teamsCatalogDisplayNameViaGraph(appId: string, req: TeamsGraphRequester): Promise<string | undefined> {
  if (appId.length === 0) return undefined;
  try {
    const json = (await req(
      `${GRAPH_BASE}/appCatalogs/teamsApps?$filter=externalId eq '${encodeURIComponent(appId)}'&$expand=appDefinitions`,
    )) as GraphCatalogPage | null;
    const entry = Array.isArray(json?.value) ? json.value[0] : undefined;
    return trimmedName(entry?.displayName) ?? trimmedName(entry?.appDefinitions?.[0]?.displayName);
  } catch {
    return undefined;
  }
}

export async function resolveTeamsBotDisplayNameViaGraph(appId: string, req: TeamsGraphRequester): Promise<string | undefined> {
  const catalog = await teamsCatalogDisplayNameViaGraph(appId, req);
  if (catalog !== undefined) return catalog;
  return teamsBotDisplayNameViaGraph(appId, req);
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
        return await Promise.race([resolveTeamsBotDisplayNameViaGraph(await resolveTeamsAppId(teamsAppCredentials().appId), liveTeamsGraphRequest), timeout]);
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
