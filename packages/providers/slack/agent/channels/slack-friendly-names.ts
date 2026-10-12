import type { FriendlyNameResolver } from "@open-everywhere/core/agent/adapter-api.js";
import { fetchChannelDisplayName, fetchUserDisplayName } from "./slack-events.js";
import { slackInstallState } from "../setup/install-state.js";

export interface SlackFriendlyNameDeps {
  readonly userName?: (id: string) => Promise<string | undefined>;
  readonly channelName?: (id: string) => Promise<string | undefined>;
  readonly teamName?: (id: string) => Promise<string | undefined>;
}

const TEAM_NAME_TTL_MS = 30 * 60_000;
let teamNameMemo: { readonly teamId: string; readonly name: string; readonly at: number } | undefined;

async function liveTeamName(id: string): Promise<string | undefined> {
  if (teamNameMemo && teamNameMemo.teamId === id && Date.now() - teamNameMemo.at < TEAM_NAME_TTL_MS) return teamNameMemo.name;
  const install = await slackInstallState().catch(() => undefined);
  if (install?.teamId === id && install.teamName) {
    teamNameMemo = { teamId: id, name: install.teamName, at: Date.now() };
    return install.teamName;
  }
  return undefined;
}

export function slackFriendlyNameResolver(deps: SlackFriendlyNameDeps = {}): FriendlyNameResolver {
  return async (id) => {
    if (/^[UW]/.test(id)) {
      const name = await (deps.userName ?? fetchUserDisplayName)(id);
      return name ? { label: name, kind: "person" } : undefined;
    }
    if (/^[CG]/.test(id)) {
      const name = await (deps.channelName ?? fetchChannelDisplayName)(id);
      return name ? { label: `#${name.replace(/^#/, "")}`, kind: "channel" } : undefined;
    }
    if (/^T/.test(id)) {
      const name = await (deps.teamName ?? liveTeamName)(id);
      return name ? { label: name, kind: "server" } : undefined;
    }
    return undefined;
  };
}
