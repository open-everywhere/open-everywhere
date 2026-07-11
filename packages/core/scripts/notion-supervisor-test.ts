import assert from "node:assert/strict";
import {
  notionSupervisorToken,
  notionSupervisorSentinel,
  classifyNotionComment,
  buildNotionSupervisorWake,
  handleNotionSupervisorDispatch,
  shouldRotate,
  type NotionSupervisorDeps,
  type NotionSupervisorDispatch,
  type NotionSupervisorSession,
  type NotionWakeMessage,
} from "../agent/channels/notion-supervisor.js";
import { renderWake } from "../agent/channels/normalized-wake.js";
import type { NotionComment } from "../agent/channels/notion-api.js";
import type { OpenEverywhereNotionAuth } from "../agent/channels/notion-identity.js";
import { UNTRUSTED_OPEN } from "../agent/access/untrusted.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const BOT = "bot-user-id-999";
const AUTHOR = "author-user-id-111";
const PAGE = "page-456";
const DISCUSSION = "disc-789";
const NOW = () => "2026-02-18T14:05:00.000Z";

ok(notionSupervisorSentinel(3) === "oe-sup:g3", "sentinel is oe-sup:g<gen>");
ok(notionSupervisorToken(PAGE, 1) === `notion:${PAGE}:oe-sup:g1`, "token is notion:<pageId>:oe-sup:g<gen>");
ok(notionSupervisorToken(PAGE, 2).includes(":oe-sup:g"), "token carries the :oe-sup:g infix hooks/spend keys on");

const mentionRT = [{ type: "mention", plain_text: "@OE", mention: { type: "user", user: { id: BOT } } }, { type: "text", plain_text: " summarise", text: { content: " summarise" } }];
const nameDropRT = [{ type: "text", plain_text: "maybe Aria can help here", text: { content: "maybe Aria can help here" } }];
const plainRT = [{ type: "text", plain_text: "looks good to me", text: { content: "looks good to me" } }];

const base: NotionComment = { id: "c1", discussion_id: DISCUSSION, created_by: { id: AUTHOR, object: "user", type: "person" }, rich_text: plainRT };

ok(classifyNotionComment({ ...base, rich_text: mentionRT }, BOT).addressing === "direct", "structured bot @mention -> direct (guaranteed engage)");
ok(classifyNotionComment(base, BOT).addressing === "channel-watch", "plain comment -> channel-watch (judged)");
ok(classifyNotionComment({ ...base, rich_text: nameDropRT }, BOT, "Aria").addressing === "channel-watch", "name-drop text -> channel-watch (judged input, NOT a direct bypass)");
ok(classifyNotionComment(base, undefined).addressing === "drop", "unresolved bot user id -> DROP (fail-closed loop guard — the critical hardening)");
ok(classifyNotionComment({ ...base, created_by: { id: BOT, object: "user", type: "person" } }, BOT).addressing === "drop", "self-authored -> DROP (our own reply)");
ok(classifyNotionComment({ ...base, created_by: { id: "other-bot", object: "user", type: "bot" } }, BOT).addressing === "drop", "bot/integration-authored -> DROP (created_by.type != person)");
ok(classifyNotionComment({ ...base, rich_text: mentionRT }, undefined).addressing === "drop", "@mention with unresolved bot id still DROPs (fail closed)");

const trigger: NotionWakeMessage = { from: "human", id: "c-trig", authorId: AUTHOR, sentAt: "2026-03-24T18:51:00Z", text: "does section 2 still hold?" };
const siblings: NotionWakeMessage[] = [
  { from: "human", id: "c-prior", authorId: AUTHOR, sentAt: "2026-03-24T17:52:00Z", text: "an earlier note" },
  { from: "self", id: "c-mine", sentAt: "2026-07-10T09:30:00Z", text: "my earlier reply" },
];
{
  const nw = buildNotionSupervisorWake({ addressing: "channel-watch", pageId: PAGE, discussionId: DISCUSSION, trigger, threadComments: siblings });
  const { message, context } = renderWake(nw, NOW);
  ok(message.startsWith("[channel-watch]"), "channel-watch wake leads with the judged preamble");
  ok(message.includes("you are this doc's standing session"), "channel-watch wake uses the DOC container noun");
  ok(message.includes(`<wake reason="channel-activity"`), "channel-watch wake carries the envelope");
  ok(message.includes(`<channel id="${PAGE}">`), "locus.channel = the page id");
  ok(message.includes(`<thread ts="${DISCUSSION}">`), "locus.thread = the discussion id (reply anchor)");
  ok(message.includes("an earlier note") && message.includes("my earlier reply"), "discussion siblings render as backscroll");
  ok(message.includes(`trigger="true"`) && message.includes("does section 2 still hold?"), "the triggering comment is the trigger message");
  ok(message.includes(UNTRUSTED_OPEN), "comment bodies are untrusted-wrapped by the envelope");
  ok(context === undefined, "channel-watch backscroll rides the envelope, not a side context block");
}

{
  const nw = buildNotionSupervisorWake({ addressing: "direct", pageId: PAGE, discussionId: DISCUSSION, trigger: { ...trigger, text: "@OE summarise this page" }, threadComments: siblings });
  const { message } = renderWake(nw, NOW);
  ok(message === "@OE summarise this page", "direct wake is the body VERBATIM (no preamble, no envelope, backscroll ignored)");
}

{
  const mk = (unified?: boolean) => renderWake(buildNotionSupervisorWake({ addressing: "channel-watch", pageId: PAGE, discussionId: DISCUSSION, trigger, threadComments: siblings, unified }), NOW);
  const plain = mk();
  const unified = mk(true);
  ok(unified.message.includes(`<channel platform="notion" id="${PAGE}">`), "unified wake stamps the <channel platform=\"notion\"> surface address");
  ok(unified.message.includes("Cross-surface disclosure:"), "unified wake appends the P5 advisory disclosure to the judged preamble");
  ok(!plain.message.includes("platform=") && !plain.message.includes("Cross-surface disclosure"), "per-doc wake carries NO platform attr / disclosure");
  ok(mk(false).message === plain.message, "unified:false renders BYTE-IDENTICAL to the unset per-doc wake (flag-off invariant)");
  const direct = renderWake(buildNotionSupervisorWake({ addressing: "direct", pageId: PAGE, discussionId: DISCUSSION, trigger: { ...trigger, text: "@OE summarise this page" }, threadComments: siblings, unified: true }), NOW);
  ok(direct.message === "@OE summarise this page", "a unified DIRECT wake is still the body verbatim (stamp is judged-path-only by construction)");
}

const AUTH: OpenEverywhereNotionAuth = { authenticator: "notion", principalId: AUTHOR, principalType: "notion-user", attributes: { page_id: PAGE, discussion_id: DISCUSSION } };
const SURFACE = `notion/ws-1/${PAGE}`;

function dispatch(over: Partial<NotionSupervisorDispatch> = {}): NotionSupervisorDispatch {
  return { surfaceKey: SURFACE, addressing: "channel-watch", pageId: PAGE, discussionId: DISCUSSION, workspaceId: "ws-1", auth: AUTH, trigger, threadComments: siblings, ...over };
}

interface WakeCapture { token: string; message: string; context: readonly string[]; state: { discussionId: string | null; pageId: string | null; workspaceId: string | null } }

function captureDeps(session: NotionSupervisorSession, over: Partial<NotionSupervisorDeps> = {}): { deps: NotionSupervisorDeps; wakes: WakeCapture[]; touched: string[] } {
  const wakes: WakeCapture[] = [];
  const touched: string[] = [];
  const deps: NotionSupervisorDeps = {
    getOrCreateSession: async () => session,
    touchSession: async (sk) => { touched.push(sk); },
    wake: async (w) => { wakes.push({ token: w.token, message: w.message, context: w.context, state: w.state as WakeCapture["state"] }); },
    now: NOW,
    ...over,
  };
  return { deps, wakes, touched };
}

{
  const session: NotionSupervisorSession = { token: notionSupervisorToken(PAGE, 1), generation: 1, freshGeneration: true, handoffNote: null };
  const { deps, wakes, touched } = captureDeps(session);
  await handleNotionSupervisorDispatch(dispatch(), deps);
  ok(wakes.length === 1, "dispatch wakes once");
  ok(wakes[0].token === notionSupervisorToken(PAGE, 1), "wake uses the supervisor continuation token (the :oe-sup:g infix)");
  ok(wakes[0].state.discussionId === DISCUSSION && wakes[0].state.pageId === PAGE && wakes[0].state.workspaceId === "ws-1", "session state carries discussion+page+workspace for the reply");
  ok(wakes[0].message.includes("you are this doc's standing session"), "the delivered message is the doc-supervisor wake");
  ok(touched.length === 1 && touched[0] === SURFACE, "touchSession records the wake on the current generation");
  ok(!("oeUnified" in (wakes[0].state as Record<string, unknown>)), "a per-doc dispatch seeds NO oeUnified marker (byte-identical off)");
  await handleNotionSupervisorDispatch(dispatch({ unified: true }), deps);
  ok(wakes[1].message.includes(`<channel platform="notion" id="${PAGE}">`), "a unified dispatch stamps the surface address on the delivered wake");
  ok((wakes[1].state as Record<string, unknown>).oeUnified === true, "a unified dispatch seeds state.oeUnified = true (the silence gate's key)");
}

{
  const session: NotionSupervisorSession = { token: notionSupervisorToken(PAGE, 2), generation: 2, freshGeneration: true, handoffNote: "Open asks: the API rename is mid-flight." };
  const { deps, wakes } = captureDeps(session);
  await handleNotionSupervisorDispatch(dispatch(), deps);
  ok(wakes[0].message.includes("Open asks: the API rename is mid-flight."), "a fresh generation's first wake carries the handoff note");
  ok(wakes[0].message.includes(`from-generation="1"`), "handoff note is attributed to the outgoing generation");
}

ok(shouldRotate({ lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: 1000 }, NOW()) === false, "shouldRotate: a young, low-token generation is NOT rotated");
ok(shouldRotate({ lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: null }, NOW()) === true, "shouldRotate: a NULL token counter fails safe -> rotate (the infix keeps it non-null in practice)");
ok(shouldRotate({ lastWakeAt: "2026-07-01T00:00:00Z", turnCount: 5, inputTokensTotal: 1000 }, NOW()) === true, "shouldRotate: a stale (quiet-gap) generation rotates");

{
  const session: NotionSupervisorSession = { token: notionSupervisorToken(PAGE, 1), generation: 1, freshGeneration: false, handoffNote: null };
  const audits: string[] = [];
  let forced = false;
  const wakes: WakeCapture[] = [];
  let first = true;
  const deps: NotionSupervisorDeps = {
    getOrCreateSession: async () => session,
    forceRotate: async () => { forced = true; return { token: notionSupervisorToken(PAGE, 2), generation: 2, handoffNote: "carried over" }; },
    audit: async (a) => { audits.push(a); },
    now: NOW,
    wake: async (w) => {
      if (first) { first = false; throw new Error("SESSION_TOKEN_LIMIT_REACHED"); }
      wakes.push({ token: w.token, message: w.message, context: w.context, state: w.state as WakeCapture["state"] });
    },
  };
  await handleNotionSupervisorDispatch(dispatch(), deps);
  ok(forced, "terminal death -> force-rotate to a fresh generation");
  ok(audits.includes("notion.session_terminal_death"), "terminal death is audited");
  ok(wakes.length === 1 && wakes[0].token === notionSupervisorToken(PAGE, 2), "the trigger is re-delivered ONCE to the fresh generation (never lost)");
}

{
  const session: NotionSupervisorSession = { token: notionSupervisorToken(PAGE, 1), generation: 1, freshGeneration: false, handoffNote: null };
  const deps: NotionSupervisorDeps = {
    getOrCreateSession: async () => session,
    forceRotate: async () => { throw new Error("should not be called"); },
    now: NOW,
    wake: async () => { throw new Error("transient network blip"); },
  };
  await assert.rejects(() => handleNotionSupervisorDispatch(dispatch(), deps), /transient network blip/, "a transient (non-terminal) wake error propagates");
  passed++;
}

console.log(`\n✓ notion-supervisor: ${passed} assertions passed`);
