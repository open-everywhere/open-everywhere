import { readLinearIssue } from "./linear-api.js";
import { catchUpSender } from "@open-everywhere/core/agent/adapter-api.js";
import type { NormalizedMessage, SeatCatchUpFetch } from "@open-everywhere/core/agent/adapter-api.js";

const CATCH_UP_MAX_COMMENTS = 100;

export interface LinearCatchUpDeps {
  readonly readIssue: typeof readLinearIssue;
  readonly selfActorId?: string;
}

export async function fetchLinearCatchUpWindow(
  req: { container: string; sinceMs: number; organizationId?: string },
  deps: LinearCatchUpDeps = { readIssue: readLinearIssue },
): Promise<readonly NormalizedMessage[]> {
  try {
    const issue = await deps.readIssue(req.container, {
      maxComments: CATCH_UP_MAX_COMMENTS,
      ...(req.organizationId ? { organizationId: req.organizationId } : {}),
    });
    const out: NormalizedMessage[] = [];
    for (const c of issue.comments) {
      const text = c.text.trim();
      if (text.length === 0 || !c.authorId || !c.id) continue;
      const ms = Date.parse(c.createdAt ?? "");
      if (!Number.isFinite(ms) || ms < req.sinceMs) continue;
      const isSelf = deps.selfActorId !== undefined && c.authorId === deps.selfActorId;
      out.push({
        id: c.id,
        ms,
        ...(isSelf ? {} : { authorId: c.authorId }),
        sender: catchUpSender({ self: isSelf }),
        ...(c.parentId ? { type: "thread" as const, threadId: c.parentId } : { type: "channel" as const }),
        text,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function linearOrgFromChannelKey(channelKey: string | undefined): string | undefined {
  if (!channelKey) return undefined;
  const parts = channelKey.split("/");
  if (parts.length !== 3 || parts[0] !== "linear") return undefined;
  return parts[1] || undefined;
}

export const LINEAR_TIMESTAMP_PRECISION_MS = 1;

export const linearSeatCatchUpFetch: SeatCatchUpFetch = (req) => {
  const organizationId = linearOrgFromChannelKey(req.channelKey);
  return fetchLinearCatchUpWindow({
    container: req.container,
    sinceMs: req.sinceMs,
    ...(organizationId ? { organizationId } : {}),
  });
};
