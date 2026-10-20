import assert from "node:assert/strict";
import { getSettings, overrideSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";
import type { IngestedReaction, ReactionSinkDeps } from "@open-everywhere/core/agent/adapter-api.js";
import { routeLinearReactionFeedback, type LinearReactionFeedbackDeps } from "../agent/channels/linear-reaction-feedback.js";
import { parseLinearReaction } from "../agent/channels/linear-stop.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const APP_USER = "app-user-1";
const HUMAN = "human-1";
const ISSUE = "issue-3";
const APP_COMMENT = "comment-7";
const HUMAN_COMMENT = "comment-9";

function reactionBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "create",
    type: "Reaction",
    organizationId: "org-1",
    actor: { id: HUMAN },
    data: { emoji: "+1", comment: { id: APP_COMMENT, issue: { id: ISSUE } } },
    ...over,
  });
}

function captureSink(): { sink: ReactionSinkDeps; recorded: IngestedReaction[]; telem: IngestedReaction[] } {
  const recorded: IngestedReaction[] = [];
  const telem: IngestedReaction[] = [];
  return { sink: { record: async (r) => void recorded.push(r), telemetry: (r) => void telem.push(r) }, recorded, telem };
}

function deps(over: Partial<LinearReactionFeedbackDeps> = {}): { deps: LinearReactionFeedbackDeps; recorded: IngestedReaction[]; telem: IngestedReaction[] } {
  const s = captureSink();
  return {
    recorded: s.recorded,
    telem: s.telem,
    deps: {
      sink: s.sink,
      appUserId: async () => APP_USER,
      commentAuthorId: async (id) => (id === APP_COMMENT ? APP_USER : HUMAN),
      ...over,
    },
  };
}

{
  const d = deps();
  const out = await routeLinearReactionFeedback(parseLinearReaction(reactionBody())!, d.deps);
  ok(out.ingested === true && out.outcome.recorded === true, "a reaction on the APP's own comment is recorded as feedback");
  ok(d.recorded.length === 1 && d.telem.length === 1, "…through both sinks");
  const r = d.recorded[0]!;
  ok(r.surface === "linear" && r.verb === "added" && r.emoji === "+1", "…naming the surface, the verb and the glyph");
  ok(r.reactorId === HUMAN, "…and the person who reacted, never the app");
  ok(r.target.channelId === ISSUE && r.target.messageId === APP_COMMENT, "…keyed on the issue and the reacted comment");
  ok(r.emojiClass === "positive", "…bucketed on the closed vocabulary");

  const d2 = deps();
  const elsewhere = reactionBody({ data: { emoji: "+1", comment: { id: HUMAN_COMMENT, issue: { id: ISSUE } } } });
  const out2 = await routeLinearReactionFeedback(parseLinearReaction(elsewhere)!, d2.deps);
  ok(out2.ingested === true && out2.outcome.recorded === false, "negative control: the same reaction on a PERSON's comment is telemetry only");
  ok(d2.recorded.length === 0 && d2.telem.length === 1, "…the telemetry fires; only the durable write is withheld");
}

{
  const unresolvedViewer = deps({ appUserId: async () => undefined });
  const a = await routeLinearReactionFeedback(parseLinearReaction(reactionBody())!, unresolvedViewer.deps);
  ok(a.ingested === true && a.outcome.recorded === false, "an unresolved app viewer ⇒ telemetry only, never a guessed feedback row");

  const unresolvedAuthor = deps({ commentAuthorId: async () => undefined });
  const b = await routeLinearReactionFeedback(parseLinearReaction(reactionBody())!, unresolvedAuthor.deps);
  ok(b.ingested === true && b.outcome.recorded === false, "an unresolved comment author ⇒ telemetry only");

  const throwingAuthor = deps({
    commentAuthorId: async () => {
      throw new Error("graphql down");
    },
  });
  const c = await routeLinearReactionFeedback(parseLinearReaction(reactionBody())!, throwingAuthor.deps);
  ok(c.ingested === true && c.outcome.recorded === false, "a THROWING author lookup refuses the record and does not propagate");

  const throwingViewer = deps({
    appUserId: async () => {
      throw new Error("graphql down");
    },
  });
  const d = await routeLinearReactionFeedback(parseLinearReaction(reactionBody())!, throwingViewer.deps);
  ok(d.ingested === true && d.outcome.recorded === false, "a THROWING viewer lookup refuses the record and does not propagate");

  const onIssue = deps();
  const issueOnly = reactionBody({ data: { emoji: "+1", issue: { id: ISSUE } } });
  const e = await routeLinearReactionFeedback(parseLinearReaction(issueOnly)!, onIssue.deps);
  ok(e.ingested === true && e.outcome.recorded === false, "a reaction on the ISSUE (no comment) is telemetry only");
  ok(onIssue.recorded.length === 0, "…and writes nothing durable");

  const control = deps();
  ok((await routeLinearReactionFeedback(parseLinearReaction(reactionBody())!, control.deps)).ingested === true, "negative control: with both lookups answering, the same envelope records");
  ok(control.recorded.length === 1, "…exactly one row");
}

{
  const d = deps();
  const self = reactionBody({ actor: { id: APP_USER } });
  const out = await routeLinearReactionFeedback(parseLinearReaction(self)!, d.deps);
  ok(out.ingested === false, "the app's own reaction is ignored — never feedback");
  ok(d.recorded.length === 0 && d.telem.length === 0, "…and reaches neither sink");

  const noOrg = deps();
  ok((await routeLinearReactionFeedback(parseLinearReaction(reactionBody({ organizationId: undefined }))!, noOrg.deps)).ingested === false, "a delivery with no organization is refused — the surface cannot be keyed");
  const noIssue = deps();
  const orphan = reactionBody({ data: { emoji: "+1", comment: { id: APP_COMMENT } } });
  ok((await routeLinearReactionFeedback(parseLinearReaction(orphan)!, noIssue.deps)).ingested === false, "a delivery with no issue is refused — the surface cannot be keyed");
}

{
  const d = deps();
  const stopAdd = reactionBody({ data: { emoji: "raised_hand", comment: { id: APP_COMMENT, issue: { id: ISSUE } } } });
  const out = await routeLinearReactionFeedback(parseLinearReaction(stopAdd)!, d.deps);
  ok(out.ingested === false, "🔴 an ADDED ✋ never becomes a sentiment row — it is the stop mechanism");
  ok(d.recorded.length === 0 && d.telem.length === 0, "…and reaches neither sink");

  for (const spelling of ["✋", ":raised_hand:", "hand"]) {
    const s = deps();
    const body = reactionBody({ data: { emoji: spelling, comment: { id: APP_COMMENT, issue: { id: ISSUE } } } });
    ok((await routeLinearReactionFeedback(parseLinearReaction(body)!, s.deps)).ingested === false, `…and so does the "${spelling}" spelling`);
  }

  const d2 = deps();
  const stopRemove = reactionBody({ action: "remove", data: { emoji: "raised_hand", comment: { id: APP_COMMENT, issue: { id: ISSUE } } } });
  const out2 = await routeLinearReactionFeedback(parseLinearReaction(stopRemove)!, d2.deps);
  ok(out2.ingested === true && out2.outcome.recorded === true, "a REMOVED ✋ is an ordinary retraction and IS recorded");
  ok(d2.recorded[0]!.verb === "removed", "…with the removal verb");
}

{
  const saved = {
    secret: process.env.LINEAR_WEBHOOK_SECRET,
    token: process.env.LINEAR_AGENT_ACCESS_TOKEN,
  };
  const savedLinear = { organizationId: getSettings().linear.organizationId, appUserId: getSettings().linear.appUserId, appName: getSettings().linear.appName };
  process.env.LINEAR_WEBHOOK_SECRET = "test-linear-secret";
  process.env.LINEAR_AGENT_ACCESS_TOKEN = "test-linear-token";
  overrideSettingsForTest({ linear: { organizationId: "org-1" } });
  overrideSettingsForTest({ linear: { appUserId: APP_USER, appName: "Test App" } });
  const realFetch = globalThis.fetch;
  let dialled = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    dialled++;
    return new Response(JSON.stringify({ errors: [{ message: "stub: this suite makes no live Linear call" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  const { LINEAR_SIGNATURE_HEADER } = await import("../agent/channels/linear-webhook-verify.js");
  const { signLinearWebhookBody } = await import("eve/channels/linear");
  const channel = (await import("../agent/channels/linear.js")).default;
  type WebhookHandler = (req: Request, args: unknown) => Promise<Response>;
  const route = channel.routes.find((r) => r.transport !== "websocket" && r.method === "POST" && r.path === "/eve/v1/linear") as { handler: WebhookHandler } | undefined;
  ok(route !== undefined, "(precondition) the linear channel exposes its webhook route");

  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const realWarn = console.warn;

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

  let feedbackRun = 0;
  let commentRun = 0;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    await drive({ action: "create", type: "Reaction", organizationId: "org-1", actor: { id: HUMAN }, data: { emoji: "+1", comment: { id: APP_COMMENT, issue: { id: ISSUE } } } });
    feedbackRun = lines.filter((l) => l.includes(`reaction feedback on issue ${ISSUE}`)).length;
    lines.length = 0;
    await drive({ action: "create", type: "Comment", organizationId: "org-1", data: { id: "comment-8" } });
    commentRun = lines.filter((l) => l.includes("reaction feedback on issue")).length;
  } finally {
    console.log = realLog;
    console.error = realError;
    console.warn = realWarn;
    globalThis.fetch = realFetch;
    if (saved.secret === undefined) delete process.env.LINEAR_WEBHOOK_SECRET;
    else process.env.LINEAR_WEBHOOK_SECRET = saved.secret;
    if (saved.token === undefined) delete process.env.LINEAR_AGENT_ACCESS_TOKEN;
    else process.env.LINEAR_AGENT_ACCESS_TOKEN = saved.token;
    overrideSettingsForTest({ linear: savedLinear });
  }
  ok(feedbackRun === 1, "🔴 REACHABILITY: the real webhook route runs the reaction-feedback leg for a Reaction delivery");
  ok(commentRun === 0, "negative control: a Comment delivery never reaches it — the leg is narrow, not a swallow-everything");
  ok(dialled > 0, "…and it reached the author lookup, which the stub answered — this suite makes no live Linear call");
}

console.log(`✓ linear reaction-feedback: ${n} assertions`);
