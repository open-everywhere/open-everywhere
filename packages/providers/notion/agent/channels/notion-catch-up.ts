import { readNotionComments, resolveNotionCredential, type NotionCommentSummary } from "./notion-api.js";
import { notionChannelCredentialForSurface } from "./notion-credentials.js";
import { getConfig, type Domain, type NormalizedMessage, type SeatCatchUpFetch } from "@open-everywhere/core/agent/adapter-api.js";

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

const CATCH_UP_MAX_COMMENTS = 100;

const CATCH_UP_MAX_BLOCK_SCANS = 80;

const CATCH_UP_MAX_COMMENT_PAGES = 5;

function normalizeComment(c: NotionCommentSummary, selfActorId: string | undefined): NormalizedMessage | undefined {
  const text = c.text.trim();
  if (text.length === 0 || !c.authorId || !c.discussionId) return undefined;
  const ms = Date.parse(c.createdTime ?? "");
  if (!Number.isFinite(ms)) return undefined;
  const isSelf = selfActorId !== undefined && c.authorId === selfActorId;
  return {
    id: `${c.discussionId}:${c.createdTime ?? ms}`,
    ms,
    ...(isSelf ? {} : { authorId: c.authorId }),
    sender: isSelf ? "self" : c.authorKind === "person" ? "human" : "bot",
    type: "thread",
    threadId: c.discussionId,
    text,
  };
}

export interface NotionCatchUpDeps {
  readonly readComments: typeof readNotionComments;
  readonly resolveCredential: typeof resolveNotionCredential;
  readonly domains?: readonly Domain[];
  readonly selfActorId?: string;
}

const liveDeps: NotionCatchUpDeps = { readComments: readNotionComments, resolveCredential: resolveNotionCredential };

export async function fetchNotionCatchUpWindow(
  req: { container: string; threadRoot?: string; sinceMs: number; channelKey?: string },
  deps: NotionCatchUpDeps = liveDeps,
): Promise<readonly NormalizedMessage[]> {
  try {
    const credentialId = req.channelKey ? notionChannelCredentialForSurface(req.channelKey, deps.domains ?? safeDomains()) : undefined;
    const cred = await deps.resolveCredential(credentialId);
    if (!cred) return [];
    const res = await deps.readComments(req.container, {
      apiKey: cred.apiKey, endpoints: cred.endpoints,
      maxComments: CATCH_UP_MAX_COMMENTS,
      maxBlockScans: CATCH_UP_MAX_BLOCK_SCANS,
      sinceMs: req.sinceMs,
      maxCommentPages: CATCH_UP_MAX_COMMENT_PAGES,
    });
    const out: NormalizedMessage[] = [];
    for (const c of res.comments) {
      if (req.threadRoot !== undefined && c.discussionId !== req.threadRoot) continue;
      const n = normalizeComment(c, deps.selfActorId);
      if (n && n.ms >= req.sinceMs) out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

export const notionSeatCatchUpFetch: SeatCatchUpFetch = (req) =>
  fetchNotionCatchUpWindow({
    container: req.container,
    ...(req.threadRoot ? { threadRoot: req.threadRoot } : {}),
    sinceMs: req.sinceMs,
    ...(req.channelKey ? { channelKey: req.channelKey } : {}),
  });
