import { channelMessagesUrl, fetchGraphPages, liveTeamsGraphRequest, teamsTimedLinesFromRaw, threadRepliesUrl, type TeamsGraphRequester, type TeamsRenderedLine } from "./teams-read.js";
import { appendAudit, deploymentOrg, type AuditInput, type NormalizedMessage, type SeatCatchUpFetch } from "@open-everywhere/core/agent/adapter-api.js";

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
  readonly audit?: (entry: AuditInput) => Promise<void>;
}

const liveDeps: TeamsCatchUpDeps = { request: liveTeamsGraphRequest };

export const TEAMS_CATCH_UP_ACTION = "teams.catch_up";

export function teamsCatchUpScopeFromChannelKey(channelKey: string | undefined): { workspace: string; surface: string } | undefined {
  if (!channelKey) return undefined;
  const parts = channelKey.split("/");
  if (parts.length !== 3 || parts[0] !== "teams" || !parts[1] || !parts[2]) return undefined;
  return { workspace: parts[1], surface: parts[2] };
}

function httpStatusOf(err: unknown): number | undefined {
  const m = /\(HTTP (\d{3})\)/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : undefined;
}

function graphPathOf(url: string): string {
  const q = url.indexOf("?");
  const bare = q < 0 ? url : url.slice(0, q);
  const base = bare.indexOf("/v1.0/");
  return base < 0 ? bare : bare.slice(base + "/v1.0".length);
}

export async function fetchTeamsCatchUpWindow(
  req: { container: string; threadRoot?: string; sinceMs: number; channelKey?: string },
  deps: TeamsCatchUpDeps = liveDeps,
): Promise<readonly NormalizedMessage[]> {
  const scope = teamsCatchUpScopeFromChannelKey(req.channelKey);
  const record = async (detail: Readonly<Record<string, unknown>>): Promise<void> => {
    try {
      await (deps.audit ?? appendAudit)({
        org: deploymentOrg(),
        platform: "teams",
        workspace: scope?.workspace ?? "unknown",
        ...(scope ? { surface: scope.surface } : {}),
        action: TEAMS_CATCH_UP_ACTION,
        detail: { ...detail, since: new Date(req.sinceMs).toISOString() },
      });
    } catch {
    }
  };

  const target = parseTeamsCatchUpContainer(req.container);
  if (!target) {
    await record({ status: "unaddressable", resource: "none", raw: 0, kept: 0 });
    return [];
  }

  const reads: Array<{ readonly resource: "channel-messages" | "thread-replies"; readonly url: string; readonly threadRoot?: string }> = [
    { resource: "channel-messages", url: channelMessagesUrl(target.teamId, target.channelId) },
    ...(req.threadRoot ? [{ resource: "thread-replies" as const, url: threadRepliesUrl(target.teamId, target.channelId, req.threadRoot), threadRoot: req.threadRoot }] : []),
  ];

  const out: NormalizedMessage[] = [];
  for (const read of reads) {
    try {
      const raw = await fetchGraphPages(deps.request, read.url, CATCH_UP_LIMIT);
      let kept = 0;
      for (const line of teamsTimedLinesFromRaw(raw)) {
        const n = normalizeLine(line, deps.selfActorId, read.threadRoot);
        if (!n || n.ms < req.sinceMs) continue;
        out.push(n);
        kept++;
      }
      await record({ status: "ok", resource: read.resource, path: graphPathOf(read.url), raw: raw.length, kept });
    } catch (err) {
      const status = httpStatusOf(err);
      await record({ status: "error", resource: read.resource, path: graphPathOf(read.url), raw: 0, kept: 0, ...(status === undefined ? {} : { httpStatus: status }) });
    }
  }
  return out;
}

export const TEAMS_TIMESTAMP_PRECISION_MS = 1;

export const teamsSeatCatchUpFetch: SeatCatchUpFetch = (req) =>
  fetchTeamsCatchUpWindow({
    container: req.container,
    ...(req.threadRoot ? { threadRoot: req.threadRoot } : {}),
    sinceMs: req.sinceMs,
    ...(req.channelKey ? { channelKey: req.channelKey } : {}),
  });
