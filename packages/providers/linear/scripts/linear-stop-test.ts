import assert from "node:assert/strict";
import {
  isLinearStopHand,
  parseLinearReaction,
  routeLinearStopReaction,
  type LinearStopDeps,
} from "../agent/channels/linear-stop.js";
import { bindLinear, buildLinearAuth } from "../agent/channels/linear-identity.js";
import type { CancelAnchoredTurnInput, CancelResult } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const APP_USER = "app-user-1";
const HUMAN = "human-user-9";

function reactionBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "create",
    type: "Reaction",
    organizationId: "org-1",
    actor: { id: HUMAN, name: "A Person" },
    data: {
      id: "reaction-1",
      emoji: "raised_hand",
      user: { id: HUMAN },
      comment: { id: "comment-7", issue: { id: "issue-3" } },
    },
    ...over,
  });
}

function recordingDeps(over: Partial<LinearStopDeps> = {}): { deps: LinearStopDeps; calls: CancelAnchoredTurnInput[] } {
  const calls: CancelAnchoredTurnInput[] = [];
  const deps: LinearStopDeps = {
    attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
    appUserId: async () => APP_USER,
    cancel: async (input: CancelAnchoredTurnInput): Promise<CancelResult> => {
      calls.push(input);
      return { outcome: "requested", message: "Standing down — I'll stop this turn where it is." };
    },
    ...over,
  };
  return { deps, calls };
}

{
  const rx = parseLinearReaction(reactionBody());
  ok(rx !== null, "a Reaction/create delivery parses");
  ok(rx?.verb === "added", "…as an ADD");
  ok(rx?.reactorId === HUMAN, "…naming the actor who reacted");
  ok(rx?.issueId === "issue-3", "…resolving the ISSUE through the nested comment.issue.id spelling");
  ok(rx?.commentId === "comment-7", "…and the comment it landed on");

  const flat = parseLinearReaction(
    JSON.stringify({
      action: "create",
      type: "Reaction",
      organizationId: "org-1",
      data: { emoji: "✋", userId: HUMAN, issueId: "issue-3", commentId: "comment-7" },
    }),
  );
  ok(flat?.issueId === "issue-3" && flat?.commentId === "comment-7" && flat?.reactorId === HUMAN, "the FLAT foreign-key spelling parses to the same facts");

  ok(parseLinearReaction(JSON.stringify({ type: "Comment", action: "create", data: {} })) === null, "a Comment delivery is NOT a reaction (the supervisor's, never this arm's)");
  ok(parseLinearReaction(JSON.stringify({ type: "Issue", action: "update", data: {} })) === null, "an Issue delivery is NOT a reaction (the event plane's)");
  ok(parseLinearReaction("not json at all") === null, "an unparseable body yields null, never a throw");
}

{
  ok(isLinearStopHand("raised_hand"), "the bare shortcode is the stop glyph");
  ok(isLinearStopHand(":raised_hand:"), "the colon-wrapped shortcode is the stop glyph");
  ok(isLinearStopHand("✋"), "the literal character is the stop glyph");
  ok(isLinearStopHand("hand"), "the older `hand` shortcode is the stop glyph");
  ok(!isLinearStopHand("+1"), "a thumbs-up is NOT the stop glyph");
  ok(!isLinearStopHand("wave"), "a wave is NOT the stop glyph");
}

{
  const { deps, calls } = recordingDeps();
  const out = await routeLinearStopReaction(parseLinearReaction(reactionBody())!, deps);
  ok(out.stopped === true, "a human ✋ on a Linear comment CANCELS");
  ok(calls.length === 1, "…through exactly one cancelAnchoredTurn call");
  const call = calls[0]!;
  ok(call.platform === "linear", "…stamped platform linear");
  ok(call.via === "reaction", "…stamped via: reaction — the same affordance class as Slack's and Discord's ✋");
  ok(call.requestedBy === HUMAN, "…naming the person who asked");
  ok(call.query.anchorKey === "linear:issue-3:comment-7", "…offering the SHARP key (issue + comment)");
  ok(call.query.channelKey === "linear:issue-3", "…and the ISSUE key, so a reaction anywhere on the issue still resolves the newest running turn");
}

{
  const { deps, calls } = recordingDeps();
  const self = parseLinearReaction(reactionBody({ actor: { id: APP_USER } }))!;
  const out = await routeLinearStopReaction(self, deps);
  ok(out.stopped === false, "the APP's own ✋ never cancels (no self-cancel)");
  ok(calls.length === 0, "…and never reaches the cancel door at all");

  const control = recordingDeps();
  ok((await routeLinearStopReaction(parseLinearReaction(reactionBody())!, control.deps)).stopped === true, "negative control: the SAME envelope from a human DOES cancel");
}
{
  const { deps, calls } = recordingDeps({ appUserId: async () => undefined });
  const out = await routeLinearStopReaction(parseLinearReaction(reactionBody())!, deps);
  ok(out.stopped === false, "an UNRESOLVED app identity refuses the cancel (fail-closed)");
  ok(calls.length === 0, "…and reaches the cancel door zero times");

  const control = recordingDeps();
  ok((await routeLinearStopReaction(parseLinearReaction(reactionBody())!, control.deps)).stopped === true, "negative control: a RESOLVED app identity lets the same envelope cancel");
}
{
  const { deps, calls } = recordingDeps({
    appUserId: async () => {
      throw new Error("Linear is down");
    },
  });
  ok((await routeLinearStopReaction(parseLinearReaction(reactionBody())!, deps)).stopped === false, "a THROWING identity resolver refuses the cancel, and does not propagate");
  ok(calls.length === 0, "…reaching the cancel door zero times");
}

{
  const { deps, calls } = recordingDeps();
  const removal = parseLinearReaction(reactionBody({ action: "remove" }))!;
  ok(removal.verb === "removed", "(precondition) a `remove` action parses as a REMOVAL");
  ok((await routeLinearStopReaction(removal, deps)).stopped === false, "a reaction REMOVAL never cancels — the glyph's removal is meaningless");

  const wrongEmoji = parseLinearReaction(reactionBody({ data: { emoji: "+1", user: { id: HUMAN }, comment: { id: "c", issue: { id: "i" } } } }))!;
  ok((await routeLinearStopReaction(wrongEmoji, deps)).stopped === false, "a NON-stop emoji never cancels");

  const noOrg = parseLinearReaction(reactionBody({ organizationId: undefined }))!;
  ok((await routeLinearStopReaction(noOrg, deps)).stopped === false, "a delivery with no organization refuses — the surface cannot be keyed");

  const noIssue = parseLinearReaction(reactionBody({ data: { emoji: "raised_hand", user: { id: HUMAN }, comment: { id: "c" } } }))!;
  ok((await routeLinearStopReaction(noIssue, deps)).stopped === false, "a delivery that proves no issue refuses — there is nothing to resolve a turn against");

  ok(calls.length === 0, "none of the four reached the cancel door");
}

{
  const bound = bindLinear({
    session: {
      auth: {
        current: buildLinearAuth({ organizationId: "org-1", teamId: "team-1", issueId: "issue-3", commentId: "comment-7", principalId: HUMAN }),
      },
    },
  });
  assert.equal(bound.anchorChannelId, "issue-3");
  ok(bound.anchorChannelId === "issue-3", "bindLinear stows the ISSUE as the stop registry's container id");
  ok(bound.anchorMessageId === "comment-7", "…and the trigger comment as the anchor message");

  const rooted = bindLinear({
    session: {
      auth: {
        current: buildLinearAuth({ organizationId: "org-1", issueId: "issue-3", commentId: "comment-7", parentCommentId: "comment-1" }),
      },
    },
  });
  ok(rooted.anchorMessageId === "comment-1", "a THREADED reply anchors on its parent — the thread ROOT, matching the reply anchor");

  const sessionOnly = bindLinear({ session: { auth: { current: buildLinearAuth({ organizationId: "org-1", agentSessionId: "sess-1" }) } } });
  ok(sessionOnly.anchorChannelId === undefined, "a delivery with no issue contributes NO container id — never a guess");
}

{
  const saved = {
    secret: process.env.LINEAR_WEBHOOK_SECRET,
    appUser: process.env.LINEAR_APP_USER_ID,
    appName: process.env.LINEAR_APP_NAME,
  };
  process.env.LINEAR_WEBHOOK_SECRET = "test-linear-secret";
  process.env.LINEAR_APP_USER_ID = APP_USER;
  process.env.LINEAR_APP_NAME = "Test App";

  const { LINEAR_SIGNATURE_HEADER } = await import("../agent/channels/linear-webhook-verify.js");
  const { signLinearWebhookBody } = await import("eve/channels/linear");
  const channel = (await import("../agent/channels/linear.js")).default;
  type WebhookHandler = (req: Request, args: unknown) => Promise<Response>;
  const route = channel.routes.find((r) => r.transport !== "websocket" && r.method === "POST" && r.path === "/eve/v1/linear") as
    | { handler: WebhookHandler }
    | undefined;
  ok(route !== undefined, "(precondition) the linear channel exposes its webhook route");

  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = () => undefined;

  async function drive(payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify({ ...payload, webhookTimestamp: Date.now() });
    const waited: Promise<unknown>[] = [];
    const args = {
      waitUntil: (p: Promise<unknown>) => void waited.push(p),
      attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
      to: undefined,
      from: undefined,
    };
    const req = new Request("https://example.test/eve/v1/linear", {
      method: "POST",
      headers: { "content-type": "application/json", [LINEAR_SIGNATURE_HEADER]: signLinearWebhookBody(body, "test-linear-secret") },
      body,
    });
    await route!.handler(req, args).catch(() => undefined);
    await Promise.allSettled(waited);
  }

  let stopRun = 0;
  let commentRun = 0;
  try {
    await drive({ action: "create", type: "Reaction", organizationId: "org-1", actor: { id: HUMAN }, data: { emoji: "raised_hand", comment: { id: "comment-7", issue: { id: "issue-3" } } } });
    stopRun = lines.filter((l) => l.includes("stop reaction on issue issue-3")).length;
    lines.length = 0;
    await drive({ action: "create", type: "Comment", organizationId: "org-1", data: { id: "comment-8" } });
    commentRun = lines.filter((l) => l.includes("stop reaction on issue")).length;
  } finally {
    console.log = realLog;
    console.error = realError;
    for (const [k, v] of [["LINEAR_WEBHOOK_SECRET", saved.secret], ["LINEAR_APP_USER_ID", saved.appUser], ["LINEAR_APP_NAME", saved.appName]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  ok(stopRun === 1, "🔴 REACHABILITY: the real webhook route runs the stop leg on a signed ✋ reaction delivery");
  ok(commentRun === 0, "negative control: a Comment delivery runs NO stop leg");
}

console.log(`\n✓ linear-stop: ${passed} assertions passed (envelope parse in both spellings, the glyph, the cancel keys, the fail-closed reactor guard with negative controls, the binding's anchor address, and route reachability)`);
