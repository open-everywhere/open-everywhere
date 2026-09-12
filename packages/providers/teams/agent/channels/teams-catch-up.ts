import { channelMessagesUrl, fetchGraphPages, liveTeamsGraphRequest, teamsTimedLinesFromRaw, threadRepliesUrl, type TeamsGraphRequester, type TeamsRenderedLine } from "./teams-read.js";
import type { NormalizedMessage, SeatCatchUpFetch } from "@open-everywhere/core/agent/adapter-api.js";

const CATCH_UP_LIMIT = 100;

export function parseTeamsCatchUpContainer(container: string): { teamId: string; channelId: string } | undefined {
  const slash = container.indexOf("/");
  if (slash <= 0) return undefined;
  const teamId = container.slice(0, slash);
  const channelId = container.slice(slash + 1);
  if (!teamId || !channelId) return undefined;
  return { teamId, channelId };
}

function normalizeLine(
  l: TeamsRenderedLine & { readonly createdMs: number },
  selfActorId: string | undefined,
  threadRoot: string | undefined,
): NormalizedMessage | undefined {
  const text = l.text.trim();
  if (text.length === 0 || l.createdMs <= 0 || l.ts.length === 0) return undefined;
  if (l.authorId === undefined && l.bot !== true) return undefined;
  const isSelf = selfActorId !== undefined && l.authorId === selfActorId;
  return {
    id: l.ts,
    ms: l.createdMs,
    ...(isSelf || l.authorId === undefined ? {} : { authorId: l.authorId }),
    sender: isSelf ? "self" : l.bot === true ? "bot" : "human",
    ...(threadRoot ? { type: "thread" as const, threadId: threadRoot } : { type: "channel" as const }),
    text,
  };
}

export interface TeamsCatchUpDeps {
  readonly request: TeamsGraphRequester;
  readonly selfActorId?: string;
}

const liveDeps: TeamsCatchUpDeps = { request: liveTeamsGraphRequest };

export async function fetchTeamsCatchUpWindow(
  req: { container: string; threadRoot?: string; sinceMs: number },
  deps: TeamsCatchUpDeps = liveDeps,
): Promise<readonly NormalizedMessage[]> {
  try {
    const target = parseTeamsCatchUpContainer(req.container);
    if (!target) return [];
    const url = req.threadRoot
      ? threadRepliesUrl(target.teamId, target.channelId, req.threadRoot)
      : channelMessagesUrl(target.teamId, target.channelId);
    const raw = await fetchGraphPages(deps.request, url, CATCH_UP_LIMIT);
    const out: NormalizedMessage[] = [];
    for (const line of teamsTimedLinesFromRaw(raw)) {
      const n = normalizeLine(line, deps.selfActorId, req.threadRoot);
      if (!n || n.ms < req.sinceMs) continue;
      out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

export const teamsSeatCatchUpFetch: SeatCatchUpFetch = (req) =>
  fetchTeamsCatchUpWindow({ container: req.container, ...(req.threadRoot ? { threadRoot: req.threadRoot } : {}), sinceMs: req.sinceMs });
