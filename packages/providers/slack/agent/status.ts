import {
  deploymentOrg,
  getOperationalStore,
  surfaceEventVerifiedAt,
  unifiedDomainSessionKey,
  type SurfaceStatus,
} from "@open-everywhere/core/agent/adapter-api.js";
import { slackBotToken, slackSigningSecret, type SlackCredentialDeps } from "./setup/credentials.js";

const set = (v: string | undefined): boolean => v !== undefined && v.trim() !== "";

const SLACK_SESSION_PREFIXES = ["slack/", unifiedDomainSessionKey("slack/")] as const;

async function eventsVerified(): Promise<SurfaceStatus["eventsVerified"]> {
  if ((await surfaceEventVerifiedAt("slack")) !== null) return "yes";
  try {
    const store = getOperationalStore();
    const org = deploymentOrg();
    for (const prefix of SLACK_SESSION_PREFIXES) {
      const rows = await store.listChannelSessions(org, prefix);
      if (rows.length > 0) return "yes";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function slackSurfaceStatus(deps: SlackCredentialDeps = {}): Promise<Partial<SurfaceStatus>> {
  const token = set(await slackBotToken(deps));
  return {
    credentials: token && set(await slackSigningSecret(deps)) ? "yes" : "no",
    installed: token ? "yes" : "no",
    eventsVerified: await eventsVerified(),
  };
}
