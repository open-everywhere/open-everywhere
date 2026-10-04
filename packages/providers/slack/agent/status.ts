import {
  deploymentOrg,
  getOperationalStore,
  surfaceEventVerifiedAt,
  unifiedDomainSessionKey,
  type SurfaceStatus,
} from "@open-everywhere/core/agent/adapter-api.js";

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

export async function slackSurfaceStatus(env: NodeJS.ProcessEnv = process.env): Promise<Partial<SurfaceStatus>> {
  const token = set(env.SLACK_BOT_TOKEN);
  return {
    credentials: token && set(env.SLACK_SIGNING_SECRET) ? "yes" : "no",
    installed: token ? "yes" : "no",
    eventsVerified: await eventsVerified(),
  };
}
