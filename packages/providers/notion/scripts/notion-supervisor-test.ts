import assert from "node:assert/strict";
import {
  notionSupervisorToken,
  notionSupervisorSentinel,
  classifyNotionComment,
  notionNameDrop,
  buildNotionSupervisorWake,
  handleNotionSupervisorDispatch,
  notionIngestedMessages,
  planNotionSingleWindow,
  shouldRotate,
  type NotionSupervisorDeps,
  type NotionSupervisorDispatch,
  type NotionSupervisorSession,
  type NotionWakeMessage,
} from "../agent/channels/notion-supervisor.js";
import {
  singleWindowMentionPolicy,
  registerSurfaces,
  defineSurface,
  isVouchedInternal,
  _resetSurfacesForTest,
  registerAuthorTrust,
  defineAuthorTrust,
  _resetAuthorTrustForTest,
  OE_CHAT_NONMEMBER_ATTR,
  renderWake,
  UNTRUSTED_OPEN,
  type UnifiedWindowWake,
} from "@open-everywhere/core/agent/adapter-api.js";
import { notionWorkspaceKey } from "../agent/channels/notion-identity.js";
import type { NotionComment } from "../agent/channels/notion-api.js";
import type { OpenEverywhereNotionAuth } from "../agent/channels/notion-identity.js";

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
const nameDropRT = [{ type: "text", plain_text: "hey Open Everywhere, can you check section 2?", text: { content: "hey Open Everywhere, can you check section 2?" } }];
const oeTokenRT = [{ type: "text", plain_text: "oe what did we decide on the ship date?", text: { content: "oe what did we decide on the ship date?" } }];
const botNameRT = [{ type: "text", plain_text: "maybe Aria can help here", text: { content: "maybe Aria can help here" } }];
const plainRT = [{ type: "text", plain_text: "looks good to me", text: { content: "looks good to me" } }];

const base: NotionComment = { id: "c1", discussion_id: DISCUSSION, created_by: { id: AUTHOR, object: "user", type: "person" }, rich_text: plainRT };

ok(classifyNotionComment({ ...base, rich_text: mentionRT }, BOT).addressing === "direct", "structured bot @mention -> direct (guaranteed engage)");
ok(classifyNotionComment(base, BOT).addressing === "channel-watch", "plain comment -> channel-watch (judged)");
ok(classifyNotionComment({ ...base, rich_text: nameDropRT }, BOT).addressing === "direct", "brand name-drop ('Open Everywhere') -> direct (synthetic mention)");
ok(classifyNotionComment({ ...base, rich_text: oeTokenRT }, BOT).addressing === "direct", "bare 'oe' token name-drop -> direct");
ok(classifyNotionComment({ ...base, rich_text: botNameRT }, BOT, "Aria").addressing === "direct", "configured botName name-drop -> direct");
ok(classifyNotionComment({ ...base, rich_text: botNameRT }, BOT).addressing === "channel-watch", "botName name-drop with NO configured name -> stays channel-watch");

ok(notionNameDrop("hey Open Everywhere please help") === true, "matches the brand phrase");
ok(notionNameDrop("openeverywhere can you summarise") === true, "matches the no-space brand token");
ok(notionNameDrop("oe, thoughts?") === true, "matches the bare 'oe' token");
ok(notionNameDrop("Zoe said the poet does it well") === false, "does NOT fire inside Zoe/poet/does (word-boundary guard)");
ok(notionNameDrop("looks good to me") === false, "plain text does not match");
ok(notionNameDrop("ping Aria about this", "Aria") === true, "matches a configured botName");
ok(notionNameDrop("ping Ariana about this", "Aria") === false, "botName is word-boundary matched (Ariana != Aria)");
ok(notionNameDrop("anything?", "a") === false, "a 1-char botName is ignored (too noisy)");
ok(notionNameDrop("") === false, "empty text never matches");

{
  const savedShort = process.env.OE_AGENT_SHORT_NAME;
  const savedFull = process.env.OE_AGENT_NAME;
  try {
    delete process.env.OE_AGENT_SHORT_NAME;
    delete process.env.OE_AGENT_NAME;
    ok(notionNameDrop("oe what's the status?") === true, "unset env: the default short name 'oe' still matches");
    ok(notionNameDrop("hey open everywhere") === true, "unset env: the default full name 'open everywhere' still matches");

    process.env.OE_AGENT_SHORT_NAME = "ari";
    ok(notionNameDrop("ari can you look at this?") === true, "OE_AGENT_SHORT_NAME configured: the new short name matches");
    ok(notionNameDrop("oe can you look at this?") === false, "OE_AGENT_SHORT_NAME REPLACES 'oe' — the old default no longer fires");
    ok(notionNameDrop("mariana said hi") === false, "configured short name is word-boundary matched (not inside 'mariana')");
    ok(notionNameDrop("ARI thoughts?") === true, "configured short name is case-insensitive");

    process.env.OE_AGENT_NAME = "Acme Helper";
    ok(notionNameDrop("can Acme Helper summarise this") === true, "OE_AGENT_NAME configured: the new full name matches");
    ok(notionNameDrop("hey open everywhere") === false, "OE_AGENT_NAME REPLACES 'open everywhere' — the old brand no longer fires");

    process.env.OE_AGENT_SHORT_NAME = "x";
    ok(notionNameDrop("the fox is quick") === false, "a 1-char OE_AGENT_SHORT_NAME is dropped (never fires inside 'fox')");
    ok(notionNameDrop("ping Zephyr about this", "Zephyr") === true, "the platform-resolved integration name matches regardless of env");
  } finally {
    if (savedShort === undefined) delete process.env.OE_AGENT_SHORT_NAME; else process.env.OE_AGENT_SHORT_NAME = savedShort;
    if (savedFull === undefined) delete process.env.OE_AGENT_NAME; else process.env.OE_AGENT_NAME = savedFull;
  }
}
ok(classifyNotionComment(base, undefined).addressing === "drop", "unresolved bot user id -> DROP (fail-closed loop guard — the critical hardening)");
ok(classifyNotionComment({ ...base, created_by: { id: BOT, object: "user", type: "person" } }, BOT).addressing === "drop", "self-authored -> DROP (our own reply)");
ok(classifyNotionComment({ ...base, created_by: { id: "other-bot", object: "user", type: "bot" } }, BOT).addressing === "drop", "bot/integration-authored -> DROP (created_by.type != person)");
ok(classifyNotionComment({ ...base, rich_text: mentionRT }, undefined).addressing === "drop", "@mention with unresolved bot id still DROPs (fail closed)");

const trigger: NotionWakeMessage = { from: "human", id: "c-trig", authorId: AUTHOR, sentAt: "2026-03-24T18:51:00Z", text: "does section 2 still hold?", trust: "peer" };
const siblings: NotionWakeMessage[] = [
  { from: "human", id: "c-prior", authorId: AUTHOR, sentAt: "2026-03-24T17:52:00Z", text: "an earlier note", trust: "peer" },
  { from: "self", id: "c-mine", sentAt: "2026-07-10T09:30:00Z", text: "my earlier reply", trust: "relay" },
];
{
  const nw = buildNotionSupervisorWake({ addressing: "channel-watch", pageId: PAGE, discussionId: DISCUSSION, trigger, threadComments: siblings });
  const { message, context } = renderWake(nw, NOW);
  ok(message.startsWith("[channel-watch]"), "channel-watch wake leads with the judged preamble");
  ok(message.includes("you are this doc's standing session"), "channel-watch wake uses the DOC container noun");
  ok(message.includes(`<wake reason="channel-activity"`), "channel-watch wake carries the envelope");
  ok(message.includes(`<channel id="${PAGE}" container="doc">`), "locus.channel = the page id; the S1 <channel container> attribute mirrors the DOC noun (OPE-684)");
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
  ok(unified.message.includes(`<channel platform="notion" id="${PAGE}" container="doc">`), "unified wake stamps the <channel platform=\"notion\"> surface address");
  ok(unified.message.includes("Cross-surface disclosure:"), "unified wake appends the P5 advisory disclosure to the judged preamble");
  ok(!plain.message.includes("platform=") && !plain.message.includes("Cross-surface disclosure"), "per-doc wake carries NO platform attr / disclosure");
  ok(mk(false).message === plain.message, "unified:false renders BYTE-IDENTICAL to the unset per-doc wake (flag-off invariant)");
  const direct = renderWake(buildNotionSupervisorWake({ addressing: "direct", pageId: PAGE, discussionId: DISCUSSION, trigger: { ...trigger, text: "@OE summarise this page" }, threadComments: siblings, unified: true }), NOW);
  ok(direct.message === "@OE summarise this page", "a unified DIRECT wake is still the body verbatim (stamp is judged-path-only by construction)");
}

{
  const target = { discussionId: DISCUSSION, pageId: PAGE, workspaceId: "ws-1" };
  const mention = planNotionSingleWindow(true, true, true, target);
  ok(mention !== undefined && mention.addressing === "direct-mention", "plan: singleWindow @mention on a VOUCHED page → window with addressing 'direct-mention' (the unified window owns the mention)");
  ok(
    mention!.origin.platform === "notion" &&
      (mention!.origin as { discussionId?: string }).discussionId === DISCUSSION &&
      (mention!.origin as { pageId?: string }).pageId === PAGE &&
      (mention!.origin as { workspaceId?: string }).workspaceId === "ws-1",
    "plan: the frozen origin names the discussion (the reply target) + page + workspace",
  );
  ok(typeof mention!.wakeId === "string" && mention!.wakeId.length > 0, "plan: a host-minted wakeId rides the window");
  ok(planNotionSingleWindow(true, true, false, target) === undefined, "plan: @mention on an UN-VOUCHED page (privacyOk=false) → NO window (privacy floor)");
  const ambient = planNotionSingleWindow(true, false, true, target);
  ok(ambient !== undefined && ambient.addressing === undefined, "plan: ambient comment on a singleWindow vouched page → window WITHOUT addressing (Leg A — judged treatment, prose stays hard-dropped)");
  ok(planNotionSingleWindow(true, false, false, target) === undefined, "plan: ambient on an un-vouched page → NO window (the floor gates BOTH legs)");
  ok(planNotionSingleWindow(false, true, true, target) === undefined && planNotionSingleWindow(false, false, true, target) === undefined, "plan: singleWindow OFF → NO window (byte-identical native path)");
  ok(planNotionSingleWindow(true, true, true, { discussionId: "" }) === undefined, "plan: an empty discussionId → NO window (no frozen reply target, fail-closed)");
  for (const sw of [true, false]) for (const ok_ of [true, false]) {
    const p = singleWindowMentionPolicy(sw, true, ok_);
    const w = planNotionSingleWindow(sw, true, ok_, target);
    ok((w !== undefined) === p.suppressNative && (w?.addressing === "direct-mention") === (p.addressing === "direct-mention"), `plan⟺seam complementarity for a mention (sw=${sw}, privacyOk=${ok_})`);
  }
}

{
  _resetSurfacesForTest();
  const WS = "ws-vouch";
  const VOUCHED_PAGE = "page-vouched";
  const UNVOUCHED_PAGE = "page-unvouched";
  const wsKey = notionWorkspaceKey(WS);
  const vouchedSk = `notion/${WS}/${VOUCHED_PAGE}`;
  const unvouchedSk = `notion/${WS}/${UNVOUCHED_PAGE}`;
  ok(!isVouchedInternal(wsKey, vouchedSk) && !isVouchedInternal(wsKey, unvouchedSk), "vouch floor: with nothing registered, no Notion surface is internal (fail-closed default)");
  registerSurfaces([defineSurface({ key: wsKey, trust: "internal" })]);
  ok(isVouchedInternal(wsKey, vouchedSk), "vouch floor: a workspace-level vouch (notion/<ws>) admits a page under it");
  const resolve = (sk: string) => isVouchedInternal(wsKey, sk);
  ok(planNotionSingleWindow(true, true, resolve(vouchedSk), { discussionId: DISCUSSION, pageId: VOUCHED_PAGE, workspaceId: WS })?.addressing === "direct-mention", "vouch floor: a VOUCHED page's @mention diverts (addressing 'direct-mention')");
  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: vouchedSk, trust: "internal" })]);
  ok(isVouchedInternal(wsKey, vouchedSk) && !isVouchedInternal(wsKey, unvouchedSk), "vouch floor: a surface-level vouch narrows to the one page (a sibling stays external)");
  ok(planNotionSingleWindow(true, true, resolve(unvouchedSk), { discussionId: DISCUSSION, pageId: UNVOUCHED_PAGE, workspaceId: WS }) === undefined, "vouch floor: an UN-VOUCHED page's @mention takes the NATIVE path (fail-closed — no cross-surface leak to an external guest)");
  _resetSurfacesForTest();
}

{
  const mk = (over: { wakeId?: string; directMention?: boolean; unified?: boolean } = {}) =>
    renderWake(
      buildNotionSupervisorWake({ addressing: "direct", pageId: PAGE, discussionId: DISCUSSION, trigger: { ...trigger, text: "@OE what did we decide?" }, threadComments: siblings, ...over }),
      NOW,
    );
  const dm = mk({ wakeId: "wake-notion-1", directMention: true, unified: true });
  ok(dm.message.startsWith("[direct]"), "direct-mention wake leads with the ADDRESSED preamble (not the silence-biased watch one)");
  ok(dm.message.includes(`wake-id="wake-notion-1"`), "direct-mention wake keeps the ENVELOPE with the wake-id (the reply tool's routing key)");
  ok(dm.message.includes(`reason="mention"`) && dm.message.includes(`mention="true"`), "direct-mention wake is an honest mention (reason + response-obligation flag)");
  ok(dm.message.includes(`<channel platform="notion" id="${PAGE}" container="doc">`), "direct-mention wake carries the unified surface address");
  ok(dm.message.includes("an earlier note"), "direct-mention wake keeps the discussion backscroll (context the shared window lacks)");
  ok(mk().message === "@OE what did we decide?", "plain direct wake (no window) stays the body VERBATIM — byte-identical off");
  const watch = renderWake(buildNotionSupervisorWake({ addressing: "channel-watch", pageId: PAGE, discussionId: DISCUSSION, trigger, threadComments: siblings, directMention: true }), NOW);
  ok(watch.message.startsWith("[channel-watch]"), "directMention alongside channel-watch addressing is ignored (guarded on `direct`)");
  const watchId = renderWake(buildNotionSupervisorWake({ addressing: "channel-watch", pageId: PAGE, discussionId: DISCUSSION, trigger, threadComments: siblings, wakeId: "wake-notion-2" }), NOW);
  ok(watchId.message.includes(`wake-id="wake-notion-2"`), "a Leg-A judged wake carries its wake-id in the envelope");
  ok(watchId.message.includes("must be a `reply` call"), "ambient single-window Leg-A wake carries the reply-tool delivery mandate (the model must call `reply`, not answer in dropped prose)");
  ok(watchId.message.includes("turn-final text is DISCARDED"), "ambient single-window Leg-A wake states the hard consequence: turn-final text is discarded on this session");
  const watchNoWindow = renderWake(buildNotionSupervisorWake({ addressing: "channel-watch", pageId: PAGE, discussionId: DISCUSSION, trigger, threadComments: siblings }), NOW);
  ok(!watchNoWindow.message.includes("wake-id"), "no window → the envelope carries NO wake-id attribute (byte-identical render)");
  ok(!watchNoWindow.message.includes("must be a `reply` call") && !watchNoWindow.message.includes("turn-final text is DISCARDED"), "no window → the reply-tool mandate is NOT appended (byte-identical to the per-surface path — turn-final prose still posts there)");
}

const AUTH: OpenEverywhereNotionAuth = { authenticator: "notion", principalId: AUTHOR, principalType: "notion-user", attributes: { page_id: PAGE, discussion_id: DISCUSSION } };
const SURFACE = `notion/ws-1/${PAGE}`;

function dispatch(over: Partial<NotionSupervisorDispatch> = {}): NotionSupervisorDispatch {
  return { surfaceKey: SURFACE, credentialId: "channel-key", addressing: "channel-watch", pageId: PAGE, discussionId: DISCUSSION, workspaceId: "ws-1", auth: AUTH, trigger, threadComments: siblings, ...over };
}

interface WakeCapture { token: string; message: string; context: readonly string[]; state: { discussionId: string | null; pageId: string | null; workspaceId: string | null }; window?: UnifiedWindowWake }

function captureDeps(session: NotionSupervisorSession, over: Partial<NotionSupervisorDeps> = {}): { deps: NotionSupervisorDeps; wakes: WakeCapture[]; touched: string[] } {
  const wakes: WakeCapture[] = [];
  const touched: string[] = [];
  const deps: NotionSupervisorDeps = {
    getOrCreateSession: async () => session,
    touchSession: async (sk) => { touched.push(sk); },
    wake: async (w) => { wakes.push({ token: w.token, message: w.message, context: w.context, state: w.state as WakeCapture["state"], window: w.window }); },
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
  ok(wakes[1].message.includes(`<channel platform="notion" id="${PAGE}" container="doc">`), "a unified dispatch stamps the surface address on the delivered wake");
  ok((wakes[1].state as Record<string, unknown>).oeUnified === true, "a unified dispatch seeds state.oeUnified = true (the silence gate's key)");
  ok(wakes[0].window === undefined && wakes[1].window === undefined, "no single-window plan → the dispatch threads NO window to the wake dep (byte-identical base path)");
  const win = planNotionSingleWindow(true, true, true, { discussionId: DISCUSSION, pageId: PAGE, workspaceId: "ws-1" })!;
  await handleNotionSupervisorDispatch(dispatch({ addressing: "direct", unified: true, window: win, directMention: true, trigger: { ...trigger, text: "@OE what did we decide?" } }), deps);
  ok(wakes[2].window === win, "a single-window dispatch threads the window through to the wake dep (the wiring's divert key)");
  ok(wakes[2].message.includes(`wake-id="${win.wakeId}"`), "the delivered direct-mention wake carries the window's wake-id in its envelope");
  ok(wakes[2].message.startsWith("[direct]"), "the delivered wake is the ADDRESSED direct-mention render");
}

{
  const session: NotionSupervisorSession = { token: notionSupervisorToken(PAGE, 2), generation: 2, freshGeneration: true, handoffNote: "Open asks: the API rename is mid-flight." };
  const { deps, wakes } = captureDeps(session);
  await handleNotionSupervisorDispatch(dispatch(), deps);
  ok(wakes[0].message.includes("Open asks: the API rename is mid-flight."), "a fresh generation's first wake carries the handoff note");
  ok(wakes[0].message.includes(`from-generation="1"`), "handoff note is attributed to the outgoing generation");
}

ok(shouldRotate({ createdAt: NOW(), lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: 1000 }, NOW()) === false, "shouldRotate: a young, low-token generation is NOT rotated");
ok(shouldRotate({ createdAt: NOW(), lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: null }, NOW()) === true, "shouldRotate: a NULL token counter fails safe -> rotate (the infix keeps it non-null in practice)");
ok(shouldRotate({ createdAt: NOW(), lastWakeAt: "2026-07-01T00:00:00Z", turnCount: 5, inputTokensTotal: 1000 }, NOW()) === true, "shouldRotate: a stale (quiet-gap) generation rotates");
ok(shouldRotate({ createdAt: "2026-05-01T00:00:00Z", lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: 1000 }, NOW()) === true, "shouldRotate: an AGED generation rotates even though it was woken a moment ago (OPE-345 expiry)");

for (const [label, err] of [
  ["a gateway blip", new Error("transient network blip")],
  ["an eve session-limit-shaped error", new Error("SESSION_TOKEN_LIMIT_REACHED")],
] as const) {
  const session: NotionSupervisorSession = { token: notionSupervisorToken(PAGE, 1), generation: 1, freshGeneration: false, handoffNote: null };
  let touched = false;
  const wakes: WakeCapture[] = [];
  const deps: NotionSupervisorDeps = {
    getOrCreateSession: async () => session,
    touchSession: async () => { touched = true; },
    now: NOW,
    wake: async (w) => {
      wakes.push({ token: w.token, message: w.message, context: w.context, state: w.state as WakeCapture["state"] });
      throw err;
    },
  };
  await assert.rejects(() => handleNotionSupervisorDispatch(dispatch(), deps), /transient network blip|SESSION_TOKEN_LIMIT_REACHED/, `${label} propagates out of the dispatch`);
  passed++;
  ok(wakes.length === 1, `${label}: exactly one wake attempt (no retry, no rotate-and-redeliver)`);
  ok(!touched, `${label}: the session is NOT touched`);
}

{
  const notionWake = buildNotionSupervisorWake({
    addressing: "channel-watch", pageId: "P1", discussionId: "D1",
    trigger: { from: "human", id: "c9", authorId: "n-user", sentAt: "2026-07-11T00:00:00Z", text: "hm", trust: "relay" },
    threadComments: [{ from: "human", id: "c8", authorId: "n-admin", sentAt: "2026-07-11T00:00:00Z", text: "earlier", trust: "principal" }],
  });
  ok(notionWake.trigger.kind === "message" && notionWake.trigger.message.trust === "relay", "wake-trust: resolved trigger trust rides in (direct-addressing no longer implies principal)");
  ok(notionWake.backscroll?.[0]?.trust === "principal", "wake-trust: resolved sibling trust rides into the backscroll");
  const notionDirect = buildNotionSupervisorWake({
    addressing: "direct", pageId: "P1", discussionId: "D1",
    trigger: { from: "human", id: "c9", authorId: "n-user", sentAt: "2026-07-11T00:00:00Z", text: "hm", trust: "unauth" },
  });
  ok(notionDirect.trigger.kind === "message" && notionDirect.trigger.message.trust === "unauth", "wake-trust: a DIRECT wake keeps the caller's fail-closed tier — directness never raises it");
  ok(notionDirect.trigger.kind === "message" && notionDirect.trigger.message.mention === true, "wake-trust: …and directness rides the `mention` flag instead (the negative control on the line above)");
  function __ope596NotionPins(): void {
    void buildNotionSupervisorWake({ addressing: "direct", pageId: "P1", discussionId: "D1", trigger: { from: "human", id: "c9", authorId: "n-user", sentAt: "2026-07-11T00:00:00Z", text: "hm" } });
    void buildNotionSupervisorWake({
      addressing: "channel-watch", pageId: "P1", discussionId: "D1",
      trigger: { from: "human", id: "c9", authorId: "n-user", sentAt: "2026-07-11T00:00:00Z", text: "hm", trust: "peer" },
      threadComments: [{ from: "human", id: "c8", authorId: "n-other", sentAt: "2026-07-11T00:00:00Z", text: "earlier" }],
    });
  }
  void __ope596NotionPins;
}

{
  const GUEST = "notion-guest-999";
  const WS = "notion/ws-1";

  const graded = notionIngestedMessages({
    workspaceId: "ws-1",
    trigger: { from: "human", id: "c1", authorId: AUTHOR, sentAt: "2026-03-24T17:52:00Z", text: "hi", trust: "peer" },
    threadComments: [{ from: "human", id: "c0", authorId: GUEST, sentAt: "2026-07-10T08:00:00Z", text: "earlier", trust: "peer" }],
  });
  ok(graded.length === 2, "the ingested set covers the trigger AND every hydrated sibling — Notion re-sends the whole discussion each wake");
  ok(graded.every((m) => m.refuted === undefined), "🔴 `refuted` is never set: Notion has no verdict to give, and a hardcoded `false` would read as \"we asked and it was fine\"");
  ok(graded[0]?.authorTrust?.tenantKey === WS && graded[0]?.authorTrust?.authorId === AUTHOR, "the trigger carries the author-trust query, keyed on the workspace");
  ok(graded[1]?.authorTrust?.authorId === GUEST, "…and so does the sibling, with ITS OWN author (never the trigger's)");
  ok(
    notionIngestedMessages({ workspaceId: null, trigger, threadComments: [] })[0]?.authorTrust === undefined,
    "🔴 negative control: with NO workspace id there is no tenant key to compose, so no author question is asked — fail OPEN, never a guessed tenant",
  );

  const session: NotionSupervisorSession = { token: notionSupervisorToken(PAGE, 1), generation: 1, freshGeneration: true, handoffNote: null };
  const auths: OpenEverywhereNotionAuth[] = [];
  const deps: NotionSupervisorDeps = {
    getOrCreateSession: async () => session,
    wake: async (w) => { auths.push(w.auth); },
    now: NOW,
  };
  const withGuest = dispatch({
    trigger: { ...trigger, trust: "peer" },
    threadComments: [{ from: "human", id: "c0", authorId: GUEST, sentAt: "2026-07-10T08:00:00Z", text: "earlier", trust: "peer" }],
  });

  await handleNotionSupervisorDispatch(withGuest, deps);
  ok(auths[0] === AUTH, "🔴 UNARMED: the delivered auth is the SAME OBJECT by reference — an undeclared workspace behaves exactly as before OPE-516");

  try {
    registerAuthorTrust([defineAuthorTrust({ tenant: WS, internal: [`notion/${AUTHOR}`] })]);
    await handleNotionSupervisorDispatch(withGuest, deps);
    ok(
      auths[1]?.attributes[OE_CHAT_NONMEMBER_ATTR] === "true",
      "🔴 ARMED: a guest's hydrated sibling on a declared workspace stamps the carriage — the author leg Notion could never have had",
    );
    ok(auths[1] !== AUTH && (AUTH.attributes as Record<string, unknown>)[OE_CHAT_NONMEMBER_ATTR] === undefined, "…on a NEW object; the caller's auth is never mutated");

    await handleNotionSupervisorDispatch(dispatch({ trigger: { ...trigger, trust: "peer" }, threadComments: [] }), deps);
    ok(
      auths[2] === AUTH,
      "🔴 NEGATIVE CONTROL: with only the DECLARED author ingested, the armed workspace stamps NOTHING — the leg discriminates, it is not an always-on bit",
    );
  } finally {
    _resetAuthorTrustForTest();
  }
}

{
  const GUEST = "notion-guest-777";
  const WS = "notion/ws-1";
  const SECRET = "SECRET-GUEST-TEXT-do-not-deliver";
  const guestComment: NotionWakeMessage = { from: "human", id: "c-guest", authorId: GUEST, sentAt: "2026-07-10T08:00:00Z", text: SECRET, trust: "peer" };

  const session: NotionSupervisorSession = { token: notionSupervisorToken(PAGE, 1), generation: 1, freshGeneration: true, handoffNote: null };

  function run(over: Partial<NotionSupervisorDispatch>): Promise<{ messages: string[]; auths: OpenEverywhereNotionAuth[] }> {
    const messages: string[] = [];
    const auths: OpenEverywhereNotionAuth[] = [];
    const deps: NotionSupervisorDeps = {
      getOrCreateSession: async () => session,
      wake: async (w) => { messages.push(w.message); auths.push(w.auth); },
      now: NOW,
    };
    return handleNotionSupervisorDispatch(dispatch(over), deps).then(() => ({ messages, auths }));
  }

  try {
    registerAuthorTrust([defineAuthorTrust({ tenant: WS, internal: [`notion/${AUTHOR}`] })]);

    const withheld = await run({
      externalPolicy: { authorGrain: "withhold", roomGrain: "engage" },
      trigger: { ...trigger, trust: "peer" },
      threadComments: [guestComment],
    });
    ok(withheld.messages.length === 1, "BEHAVIOUR 3: a permitted member's comment still wakes the agent — withholding an author does not silence the thread");
    ok(!withheld.messages[0]!.includes(SECRET), "🔴 BEHAVIOUR 3: the excluded author's TEXT is not in the delivered wake — it never reached renderWake");
    ok(withheld.messages[0]!.includes("a message arrived here"), "…and the arrived-marker IS, so the model knows a message it cannot read exists");
    ok(withheld.messages[0]!.includes(GUEST), "…still attributed: WHO and WHEN survive, which is what makes the marker legible");
    ok(
      withheld.auths[0]?.attributes[OE_CHAT_NONMEMBER_ATTR] === undefined,
      "🔴 THE TAINT PROPERTY: a WITHHELD body never keys the chat-taint bit — those bytes did not enter the context, so claiming they did would be false",
    );

    const tainted = await run({
      externalPolicy: { authorGrain: "taint", roomGrain: "engage" },
      trigger: { ...trigger, trust: "peer" },
      threadComments: [guestComment],
    });
    ok(tainted.messages[0]!.includes(SECRET), "🔴 NEGATIVE CONTROL: on the shipped `taint` grain the same comment IS delivered in full");
    ok(
      tainted.auths[0]?.attributes[OE_CHAT_NONMEMBER_ATTR] === "true",
      "🔴 NEGATIVE CONTROL: …and it DOES key taint, which is the behaviour `withhold` replaces rather than duplicates",
    );

    const legacy = await run({ trigger: { ...trigger, trust: "peer" }, threadComments: [guestComment] });
    ok(legacy.messages[0]!.includes(SECRET), "a dispatch carrying NO policy resolves the org default — byte-identical to before this field existed");

    const suppressed = await run({
      externalPolicy: { authorGrain: "withhold", roomGrain: "engage" },
      trigger: { ...guestComment, id: "c-trigger" },
      threadComments: [],
    });
    ok(suppressed.messages.length === 0, "🔴 BEHAVIOUR 2: an excluded author's own comment wakes NOTHING — no session, no turn, no reply");

    const suppressedControl = await run({
      externalPolicy: { authorGrain: "taint", roomGrain: "engage" },
      trigger: { ...guestComment, id: "c-trigger" },
      threadComments: [],
    });
    ok(suppressedControl.messages.length === 1, "🔴 NEGATIVE CONTROL: the identical trigger on `taint` DOES wake the agent");

    const permitted = await run({
      externalPolicy: { authorGrain: "withhold", roomGrain: "engage" },
      trigger: { ...trigger, trust: "peer" },
      threadComments: [],
    });
    ok(permitted.messages.length === 1 && permitted.auths[0] === AUTH, "negative control: a DECLARED author is delivered in full and stamps nothing, even on `withhold`");
  } finally {
    _resetAuthorTrustForTest();
  }

  const unarmed = await run({
    externalPolicy: { authorGrain: "withhold", roomGrain: "engage" },
    trigger: { ...trigger, trust: "peer" },
    threadComments: [guestComment],
  });
  ok(
    unarmed.messages.length === 1 && unarmed.messages[0]!.includes(SECRET),
    "🔴 UNARMED: `withhold` on a workspace the operator never declared withholds NOTHING — silence is not a declaration",
  );
}

console.log(`\n✓ notion-supervisor: ${passed} assertions passed`);
