import { matchesAgentName } from "../../agent/identity/bot-name.js";
import type { AuditWireEntry } from "./audit-read.js";
import type { NotionComment } from "./notion-driver.js";
import type { TranscriptWireEvent } from "./transcript-read.js";

export const NOTION_TAINT_ANCHOR_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

const NOTION_TAINT_ANCHOR_MAX_AGE_DAYS = NOTION_TAINT_ANCHOR_MAX_AGE_MS / 86_400_000;

const NOTION_TAINT_ANCHOR_MAX_SKEW_MS = 5 * 60_000;

function asksForThePage(text: string): boolean {
  return /(?:read|review|summari[sz]e)[\s\S]{0,80}\b(?:this\s+)?page\b/i.test(text) || /\bpage\b[\s\S]{0,80}(?:read|review|summari[sz]e)/i.test(text);
}

export interface NotionTaintAnchorInput {
  readonly comment: NotionComment | undefined;
  readonly botUserId: string | undefined;
  readonly botName?: string;
  readonly nowMs: number;
}

export function notionTaintAnchorProblem(input: NotionTaintAnchorInput): string | undefined {
  const { comment, botUserId, botName, nowMs } = input;
  if (!comment) return "the configured comment id is not visible on the fixture page under the harness credential";
  if (!botUserId) {
    return "the harness could not resolve the agent's own Notion user id, so it cannot tell a human anchor from the agent's own reply (classifyNotionComment step 1 fails closed on the same fact)";
  }
  if (!comment.authorId) return "the comment carries no created_by.id — classifyNotionComment drops an unidentified author before any addressing check (step 3)";
  if (comment.authorId === botUserId) return "the comment is the agent's OWN reply (self-authored) — the loop guard drops it (step 2)";
  if (comment.authorType && comment.authorType !== "person") {
    return `the comment is ${comment.authorType}-authored, not person-authored — the bot/integration drop fires before any addressing check (step 4). Every comment created over the REST API is \`bot\`, so the anchor cannot be seeded by this driver`;
  }
  const created = Date.parse(comment.createdTime);
  if (!Number.isFinite(created)) return "the comment has no parseable created_time, so its freshness cannot be established";
  const age = nowMs - created;
  if (age < -NOTION_TAINT_ANCHOR_MAX_SKEW_MS) return "the comment is dated more than five minutes in the future — a clock fault, not a fresh ask";
  if (age > NOTION_TAINT_ANCHOR_MAX_AGE_MS) {
    return (
      `the comment is out of reach (${Math.floor(age / 86_400_000)}d old; this leg reaches back ${NOTION_TAINT_ANCHOR_MAX_AGE_DAYS}d). ` +
      "That bound is THIS LEG's, not the product's — the `direct` path reads no created_time at all — and it exists so the leg re-seeds its fixture rather than replaying a conversation nobody is having"
    );
  }
  if (!matchesAgentName(comment.text, botName)) {
    return "the comment does not NAME the agent, so classifyNotionComment returns `channel-watch` (step 7) — an engaged page then promotes it to `thread-follow`, which is judged rather than owed a reply. This is exactly the ship #217 shape";
  }
  if (!asksForThePage(comment.text)) {
    return "the comment does not ask the agent to read, review or summarise the PAGE, so a turn that runs it need never call read_notion_page and no `notion` ingestion can be declared";
  }
  return undefined;
}

export function notionTaintFixtureRemedy(pageId: string): string {
  return (
    "REMEDY, one action (a person must type it — a comment this driver creates is always Notion `bot` and can never wake the classifier): " +
    `add a comment on Notion page ${pageId}, in your own account, whose text NAMES the agent and ASKS FOR THE PAGE — ` +
    'for example "Open Everywhere — please read this page and summarise its current contents." ' +
    `The leg picks up the newest comment that qualifies, so nothing else needs setting. It reaches back ${NOTION_TAINT_ANCHOR_MAX_AGE_DAYS} days, so one comment lasts a quarter.`
  );
}

export type NotionTaintAnchorChoice =
  | { readonly ok: true; readonly comment: NotionComment; readonly considered: number }
  | { readonly ok: false; readonly reason: string; readonly considered: number };

export function chooseNotionTaintAnchor(
  comments: readonly NotionComment[],
  ctx: { readonly botUserId: string | undefined; readonly botName?: string; readonly nowMs: number },
): NotionTaintAnchorChoice {
  const newestFirst = [...comments].sort((a, b) => (a.createdTime < b.createdTime ? 1 : a.createdTime > b.createdTime ? -1 : 0));
  const considered = newestFirst.length;
  for (const comment of newestFirst) {
    if (notionTaintAnchorProblem({ ...ctx, comment }) === undefined) return { ok: true, comment, considered };
  }
  if (considered === 0) return { ok: false, reason: "the fixture page carries no comments this credential can see", considered };
  const humanish = newestFirst.find((c) => c.authorId && c.authorId !== ctx.botUserId && (!c.authorType || c.authorType === "person"));
  const blamed = humanish ?? newestFirst[0]!;
  const why = notionTaintAnchorProblem({ ...ctx, comment: blamed }) ?? "it qualifies (which contradicts this branch — treat as a harness bug)";
  return {
    ok: false,
    reason: `none of the ${considered} comment(s) on the fixture page can be replayed. The newest ${humanish ? "person-authored" : ""} one (${blamed.id}) is closest, and ${why}`,
    considered,
  };
}

function detail(row: AuditWireEntry): Record<string, unknown> {
  return (row.detail ?? {}) as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface NotionTaintReplayEvidence {
  readonly dispatch: AuditWireEntry;
  readonly turnStart: AuditWireEntry;
  readonly lifecycle?: AuditWireEntry;
  readonly verdict: AuditWireEntry;
  readonly wakeId: string;
  readonly sessionId: string;
  readonly verdictSessionId: string;
}

export type NotionTaintReplayResult =
  | { readonly ok: true; readonly evidence: NotionTaintReplayEvidence }
  | { readonly ok: false; readonly reason: string; readonly fixture?: true };

export interface NotionTaintReplayInput {
  readonly deliveryId: string;
  readonly commentId: string;
  readonly discussionId: string;
}

export function notionTaintReplayEvidence(rows: readonly AuditWireEntry[], input: NotionTaintReplayInput): NotionTaintReplayResult {
  const dispatches = rows.filter((row) => row.action === "notion.dispatched" && str(detail(row).deliveryId) === input.deliveryId);
  if (dispatches.length === 0) {
    const forComment = rows.filter((row) => row.action === "notion.dispatched" && str(detail(row).commentId) === input.commentId);
    return {
      ok: false,
      reason:
        forComment.length > 0
          ? `no notion.dispatched row carries this forge's deliveryId ${input.deliveryId}, though ${forComment.length} row(s) name the same comment — this run's own replay never reached dispatch`
          : "no notion.dispatched row names this forge's delivery — the replay was acked but never dispatched (a verification, credential, scope or once-guard refusal, all of which row separately)",
    };
  }
  if (dispatches.length > 1) return { ok: false, reason: `${dispatches.length} notion.dispatched rows carry one deliveryId ${input.deliveryId} — the delivery id is not identifying and the join cannot be trusted` };
  const dispatch = dispatches[0]!;
  const dd = detail(dispatch);
  if (str(dd.commentId) !== input.commentId) return { ok: false, reason: `the dispatched row for this delivery names comment ${String(dd.commentId)}, not the configured anchor ${input.commentId}` };
  if (str(dd.discussionId) !== input.discussionId) return { ok: false, reason: `the dispatched row names discussion ${String(dd.discussionId)}, not the anchor's ${input.discussionId}` };
  if (dd.addressing !== "direct") {
    return {
      ok: false,
      reason: `the delivery was dispatched as \`${String(dd.addressing)}\`, not \`direct\` — the anchor did not reach the addressed arm, so the seat judged it rather than being asked. Re-seed the fixture (see the preflight's remedy); do NOT relax this clause`,
    };
  }
  const wakeId = str(dd.wakeId);
  if (!wakeId) {
    return {
      ok: false,
      fixture: true,
      reason:
        "the dispatched row carries no wakeId — this delivery minted no single-window wake, so there is no id joining it to a turn and this leg has measured nothing about the taint plane either way. " +
        "Bind the fixture page's domain in `unified` mode (agent/memory/config/domains/) and re-run",
    };
  }
  const turnStart = rows.find((row) => row.action === "wake.turn_start" && str(detail(row).wakeId) === wakeId);
  if (!turnStart) return { ok: false, reason: `wake ${wakeId} was dispatched but no wake.turn_start row followed it — the wake never became a turn` };
  const sessionId = str(detail(turnStart).sessionId);
  if (!sessionId) return { ok: false, reason: `the wake.turn_start row for ${wakeId} carries no sessionId, so the turn cannot be joined to what it did` };
  const lifecycle = rows.find(
    (row) => (row.action === "notion.replied" || row.action === "notion.no_reply") && str(detail(row).sessionId) === sessionId,
  );
  const verdict = rows.find((row) => {
    const d = detail(row);
    return row.action === "taint.verdict" && d.kind === "notion" && (str(d.sessionId) === sessionId || str(d.parentSessionId) === sessionId);
  });
  if (!verdict) {
    const decided = lifecycle ? ` The seat's own terminal row for this session is \`${lifecycle.action}\`.` : "";
    return {
      ok: false,
      reason: `the replay's turn ran (session ${sessionId}) but wrote no \`notion\` taint.verdict row attributed to it — nothing in that turn, or in a worker it delegated to, declared a Notion page read.${decided}`,
    };
  }
  const vd = detail(verdict);
  return {
    ok: true,
    evidence: {
      dispatch,
      turnStart,
      ...(lifecycle ? { lifecycle } : {}),
      verdict,
      wakeId,
      sessionId,
      verdictSessionId: str(vd.sessionId) ?? sessionId,
    },
  };
}

export function transcriptHasNotionPageRead(events: readonly TranscriptWireEvent[]): boolean {
  return events.some(
    (event) => (event.type === "actions.requested" || event.type === "action.result") && JSON.stringify(event.data ?? null).includes('"read_notion_page"'),
  );
}
