import { createHmac } from "node:crypto";
import { notionCommentIsStopDirective, routeNotionStopComment, type NotionStopDeps } from "../agent/channels/notion-stop.js";
import type { NotionOwnBotIds } from "../agent/channels/notion-bot-user.js";
import { bindNotion, buildNotionAuth, notionConversationKey } from "../agent/channels/notion-identity.js";
import { handleNotionDelivery } from "../agent/channels/notion-webhook.js";
import { registerNotionProvider } from "../agent/register.js";
import type { CancelAnchoredTurnInput, CancelResult } from "@open-everywhere/core/agent/adapter-api.js";
import type { NotionComment, FetchLike } from "../agent/channels/notion-api.js";
import type { NotionUntieredSupervisorDispatch } from "../agent/channels/notion-supervisor.js";

registerNotionProvider();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WS = "ws-989";
const PAGE = "page-989";
const DISCUSSION = "disc-989";
const BOT = "bot-989";
const AUTHOR = "author-989";

function stopComment(over: { id?: string; text?: string; authorId?: string; authorType?: string } = {}): NotionComment {
  const text = over.text ?? "stop";
  return {
    id: over.id ?? "cmt-stop",
    discussion_id: DISCUSSION,
    parent: { type: "page_id", page_id: PAGE },
    created_by: { id: over.authorId ?? AUTHOR, object: "user", type: over.authorType ?? "person" },
    rich_text: [{ type: "text", plain_text: text, text: { content: text } }],
  };
}

function recordingDeps(): { deps: NotionStopDeps; calls: CancelAnchoredTurnInput[] } {
  const calls: CancelAnchoredTurnInput[] = [];
  return {
    calls,
    deps: {
      attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
      cancel: async (input: CancelAnchoredTurnInput): Promise<CancelResult> => {
        calls.push(input);
        return { outcome: "requested", message: "Standing down — I've asked this turn to stop. I'll post the outcome in the thread." };
      },
    },
  };
}

const own = (primary: string | undefined, siblings: readonly string[] = [], complete = true): NotionOwnBotIds => ({
  primary,
  all: new Set([...(primary ? [primary] : []), ...siblings]),
  complete,
});

{
  ok(notionCommentIsStopDirective(stopComment(), own(BOT)), "a bare `stop` comment from a real, resolved human IS a stop directive");
  ok(!notionCommentIsStopDirective(stopComment({ text: "please stop" }), own(BOT)), "`please stop` is a MESSAGE, not a directive");
  ok(!notionCommentIsStopDirective(stopComment({ text: "stop, wrong page" }), own(BOT)), "a stop word inside a sentence is a MESSAGE");

  ok(!notionCommentIsStopDirective(stopComment(), own(undefined)), "🔴 an UNRESOLVED bot id fails closed — can't rule out self, so nothing is treated as a stop");
  ok(!notionCommentIsStopDirective(stopComment({ authorId: BOT }), own(BOT)), "a SELF-authored comment (our own reply) never cancels");
  ok(!notionCommentIsStopDirective(stopComment({ authorType: "bot" }), own(BOT)), "a BOT/integration-authored comment never cancels");
  ok(!notionCommentIsStopDirective(stopComment({ authorType: "bot" }), own(undefined)), "…and stays refused even with an unresolved bot id (both guards agree)");

  ok(
    !notionCommentIsStopDirective({ ...stopComment(), created_by: { object: "user" } }, own(BOT)),
    "🔴 an author with NO created_by.id never cancels — fail closed, the same posture as the classifier",
  );
  ok(
    !notionCommentIsStopDirective({ ...stopComment(), created_by: undefined }, own(BOT)),
    "🔴 …and a comment with NO created_by at all never cancels either",
  );

  ok(notionCommentIsStopDirective(stopComment({ authorId: "some-other-human" }), own(BOT)), "negative control: a DIFFERENT resolved human's bare `stop` DOES pass");
  ok(
    notionCommentIsStopDirective({ ...stopComment(), created_by: { id: "some-other-human", object: "user" } }, own(BOT)),
    "negative control: an identified human with NO created_by.type still cancels — the drop above is the missing id",
  );

  const SIBLING = "bot-of-integration-A";
  const siblingStop = { ...stopComment(), created_by: { id: SIBLING, object: "user" } };
  ok(!notionCommentIsStopDirective(siblingStop, own(BOT, [SIBLING])), "🔴 OPE-1921: a `stop` authored by a SIBLING integration's bot never cancels — our own words are recognised across every configured integration");
  ok(notionCommentIsStopDirective(siblingStop, own(BOT)), "🔴 OPE-1921 CONTROL: the SAME comment against the verifying integration's id ALONE DOES cancel — the pre-fix self-cancel");
  const untypedHuman = { ...stopComment(), created_by: { id: "some-other-human", object: "user" } };
  ok(!notionCommentIsStopDirective(untypedHuman, own(BOT, [], false)), "🔴 OPE-1921: with one configured integration's id unresolved, an author of unstated type cannot cancel — the self-check did not run, so the answer is refuse");
  ok(notionCommentIsStopDirective(untypedHuman, own(BOT)), "🔴 OPE-1921 CONTROL: the identical comment with a COMPLETE own-id set DOES cancel, so the refusal above is driven by `complete` alone");
  ok(notionCommentIsStopDirective({ ...stopComment(), created_by: { id: "some-other-human", object: "user", type: "person" } }, own(BOT, [], false)), "🔴 OPE-1921: …and an author Notion STATES is a person still cancels, so the refusal above is the ambiguity and not a blanket deafness");
}

{
  const { deps, calls } = recordingDeps();
  const out = await routeNotionStopComment({ workspaceId: WS, pageId: PAGE, discussionId: DISCUSSION, requesterId: AUTHOR }, deps);
  ok(out.stopped === true, "a human `stop` comment CANCELS");
  ok(calls.length === 1, "…through exactly one cancelAnchoredTurn call");
  const call = calls[0]!;
  ok(call.platform === "notion", "…stamped platform notion");
  ok(call.via === "reaction", "…stamped via: reaction — the affordance CLASS, the same door as a Slack ✋");
  ok(call.requestedBy === AUTHOR, "…naming the person who asked");
  ok(call.query.channelKey === `notion:${WS}/${PAGE}`, "…keyed on the PAGE conversation, not the discussion");
  ok(call.query.anchorKey === undefined, "…and offering NO anchorKey: a comment/discussion id is not the turn's anchor message, so that lookup would always miss");

  const noKey = await routeNotionStopComment({ pageId: PAGE }, deps);
  ok(noKey.stopped === false, "no workspaceId ⇒ no conversation key ⇒ refused, never a guessed cancel");
}

{
  const bound = bindNotion({
    session: { auth: { current: buildNotionAuth({ workspaceId: WS, pageId: PAGE, discussionId: DISCUSSION, principalId: AUTHOR }) } },
  });
  ok(bound.anchorChannelId === `${WS}/${PAGE}`, "bindNotion stows the CONVERSATION key (workspace/page) as the stop registry's container id");

  const { deps, calls } = recordingDeps();
  await routeNotionStopComment({ workspaceId: WS, pageId: PAGE }, deps);
  ok(calls[0]!.query.channelKey === `notion:${bound.anchorChannelId}`, "🔴 the webhook's key and the binding's key are BYTE-EQUAL — one derivation, two callers");

  ok(notionConversationKey(WS, undefined) === undefined, "a missing page yields NO key — a partial key would collide across pages");
  ok(notionConversationKey(undefined, PAGE) === undefined, "a missing workspace yields NO key");

  const noAnchor = bindNotion({ session: { auth: { current: buildNotionAuth({ workspaceId: WS }) } } });
  ok(noAnchor.anchorChannelId === undefined, "a turn with no page contributes NO container id — never a guess");
}

{
  const SECRET = "verif-tok-989";
  function sign(body: string): string {
    return "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
  }
  function commentEvent(): string {
    return JSON.stringify({
      type: "comment.created",
      workspace_id: WS,
      entity: { id: "cmt-stop", type: "comment" },
      data: { page_id: PAGE, parent: { id: PAGE, type: "page" } },
      authors: [{ id: AUTHOR, type: "person" }],
    });
  }
  function makeFetch(comment: NotionComment): FetchLike {
    return async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && /\/v1\/comments\/[^?]+$/.test(input)) return new Response(JSON.stringify(comment), { status: 200 });
      if (method === "GET" && input.includes("/v1/comments?block_id=")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    };
  }
  function baseDeps(
    fetchImpl: FetchLike,
    dispatch: (d: NotionUntieredSupervisorDispatch) => Promise<void>,
    extra?: Partial<Parameters<typeof handleNotionDelivery>[2]>,
  ): Parameters<typeof handleNotionDelivery>[2] {
    return {
      signingKeys: [{ credentialId: "channel-key", secret: SECRET }],
      allowUnverified: false,
      credentialFor: async () => ({ apiKey: "ntn_key" }),
      credentialForPage: () => undefined,
      domains: [],
      resolveBotUserId: async () => BOT,
      ambientEnabled: () => true,
      fetch: fetchImpl,
      dispatch,
      engagement: { markEventSeen: async () => true },
      attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
      ...extra,
    };
  }

  {
    let dispatched = false;
    const raw = commentEvent();
    const out = await handleNotionDelivery(
      raw,
      sign(raw),
      baseDeps(makeFetch(stopComment()), async () => { dispatched = true; }, { ambientEnabled: () => false }),
    );
    ok(out.action === "stopped", "🔴 REACHABILITY: a bare `stop` comment short-circuits to `stopped`, even with ambient OFF for the domain");
    ok(!dispatched, "…and dispatch is NEVER called — no wake on the stop delivery itself");
  }

  {
    let dispatched = false;
    const ordinary: NotionComment = { ...stopComment(), rich_text: [{ type: "text", plain_text: "can you summarise this page?", text: { content: "x" } }] };
    const raw = commentEvent();
    const out = await handleNotionDelivery(raw, sign(raw), baseDeps(makeFetch(ordinary), async () => { dispatched = true; }));
    ok(out.action === "dispatched" && dispatched, "negative control: an ordinary comment dispatches exactly as before");
  }

  {
    let dispatched = false;
    const raw = commentEvent();
    const out = await handleNotionDelivery(
      raw,
      sign(raw),
      baseDeps(makeFetch(stopComment({ authorType: "bot" })), async () => { dispatched = true; }),
    );
    ok(out.action !== "stopped", "negative control: a BOT-authored `stop` comment never short-circuits");
    ok(out.action === "skipped-bot" && !dispatched, "…it falls through to the ordinary classify drop (fail-closed, not silent)");
  }
}

console.log(`\n✓ notion-stop: ${passed} assertions passed (the fail-closed actor guard with negative controls, the cancel key, the one shared conversation-key derivation, and route reachability including the ambient-independence and negative controls)`);
