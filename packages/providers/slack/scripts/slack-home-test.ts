process.env.OE_SQLITE_PATH = ":memory:";
process.env.SLACK_BOT_TOKEN = "xoxb-test";
delete process.env.DATABASE_URL;

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  registerConfig,
  registerSurfaces,
  defineSurface,
  providerById,
  siloTier,
  getOperationalStore,
  writeMemoryTier,
  domainMembershipProbe,
  type Domain,
  type HomeBlock,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerSlackProvider } from "../agent/register.js";
import { buildFrontHandler, classifyEnvelope } from "../agent/channels/slack-front.js";
import {
  HOME_ACTION_PREFIX,
  HOME_MODAL_CALLBACK_ID,
  SLACK_HOME_MAX_BLOCKS,
  buildSlackHomeViewer,
  escapeSlackText,
  slackDomainMembershipProbe,
  handleHomeSubmission,
  parseHomeClick,
  parseHomeOpened,
  parseHomeSubmission,
  renderHomeView,
  type SlackHomeDeps,
} from "../agent/channels/slack-home.js";
import { defuseCanvasText, liveMemoryCanvasDeps, publishChannelCanvas, recheckChannelCanvas, refreshMemoryCanvases, type MemoryCanvasDeps } from "../agent/channels/slack-memory-canvas.js";
import { confirmChannelInternal, confirmChannelInternalFresh } from "../agent/channels/slack-events.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const TEAM = "T1";
const USER = "U_ALICE";
const SHA = "a".repeat(64);
const FORM = "application/x-www-form-urlencoded";
const form = (payload: unknown): string => `payload=${encodeURIComponent(JSON.stringify(payload))}`;

const PLATFORM: Domain = { name: "platform", reach: ["slack/T1/CPLAT", "slack/T1/CSHARED"], memory: "platform-brain" };
const QUIET: Domain = { name: "quiet", reach: ["slack/T1/CQUIET"], memory: "quiet-brain", memoryCanvas: false };
const BARE: Domain = { name: "bare", reach: ["slack/T1/CBARE"] };
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [PLATFORM, QUIET, BARE],
  loadSilos: () => [
    { name: "platform-brain", provider: "sqlite" },
    { name: "quiet-brain", provider: "sqlite" },
  ],
  domainsForSurface: () => [],
});
registerSlackProvider();

console.log("§1 parsing");
{
  const opened = parseHomeOpened({ type: "event_callback", team_id: TEAM, event: { type: "app_home_opened", user: USER, tab: "home", channel: "D1" } });
  ok(opened?.userId === USER && opened.teamId === TEAM, "a Home-tab open parses to the person and workspace");
  ok(parseHomeOpened({ type: "event_callback", team_id: TEAM, event: { type: "app_home_opened", user: USER, tab: "messages" } }) === undefined, "NEGATIVE: the Messages tab is not ours");

  const base = { type: "block_actions", user: { id: USER }, team: { id: TEAM }, trigger_id: "trig" };
  const btn = parseHomeClick({ ...base, actions: [{ type: "button", action_id: `${HOME_ACTION_PREFIX}memory.export` }] });
  ok(btn?.action === "memory.export" && btn.ref === undefined, "a button names its action in the action id");
  const over = parseHomeClick({ ...base, actions: [{ type: "overflow", action_id: `${HOME_ACTION_PREFIX}item`, selected_option: { value: `memory.forget|${SHA}` } }] });
  ok(over?.action === "memory.forget" && over.ref === SHA && over.triggerId === "trig", "an overflow choice names its action and the line digest");
  ok(parseHomeClick({ ...base, actions: [{ type: "overflow", action_id: `${HOME_ACTION_PREFIX}item`, selected_option: { value: "memory.forget|../../x" } }] }) === undefined, "NEGATIVE: a ref that is not a digest is refused at the parse");
  ok(parseHomeClick({ ...base, actions: [{ type: "button", action_id: "oe_approval:approve" }] }) === undefined, "NEGATIVE: another door's action id is not ours");

  const sub = parseHomeSubmission({
    type: "view_submission",
    user: { id: USER },
    team: { id: TEAM },
    view: { callback_id: HOME_MODAL_CALLBACK_ID, private_metadata: `memory.edit|${SHA}`, state: { values: { oe_home_edit: { text: { value: "new words" } } } } },
  });
  ok(sub?.action === "memory.edit" && sub.ref === SHA && sub.input === "new words" && sub.userId === USER, "a submission carries the action, the digest, the new text and the SIGNED user");
  ok(parseHomeSubmission({ type: "view_submission", user: { id: USER }, view: { callback_id: "someone_else", private_metadata: `memory.edit|${SHA}` } }) === undefined, "NEGATIVE: another modal is not ours");
}

console.log("§2 classification");
{
  const open = classifyEnvelope(JSON.stringify({ type: "event_callback", team_id: TEAM, event: { type: "app_home_opened", user: USER, tab: "home" } }), "application/json");
  ok(open.kind === "home-open", "app_home_opened (home) is ours");
  const messagesTab = classifyEnvelope(JSON.stringify({ type: "event_callback", team_id: TEAM, event: { type: "app_home_opened", user: USER, tab: "messages" } }), "application/json");
  ok(messagesTab.kind === "forward", "NEGATIVE: the Messages tab open forwards");
  const click = classifyEnvelope(form({ type: "block_actions", user: { id: USER }, team: { id: TEAM }, actions: [{ type: "button", action_id: `${HOME_ACTION_PREFIX}memory.refresh` }] }), FORM);
  ok(click.kind === "home-click", "an oe_home: click is ours");
  const sub = classifyEnvelope(form({ type: "view_submission", user: { id: USER }, team: { id: TEAM }, view: { callback_id: HOME_MODAL_CALLBACK_ID, private_metadata: `memory.forget|${SHA}` } }), FORM);
  ok(sub.kind === "home-submit", "the Home modal's submission is ours");
  const eveInput = classifyEnvelope(form({ type: "block_actions", user: { id: USER }, actions: [{ type: "button", action_id: "eve_input:x" }] }), FORM);
  ok(eveInput.kind === "forward", "NEGATIVE: eve's own click still forwards");
}

console.log("§3 rendering");
{
  ok(escapeSlackText("<!channel> & <@U1>") === "&lt;!channel&gt; &amp; &lt;@U1&gt;", "member text is escaped, so a remembered `<!channel>` cannot ping anyone");
  const items: HomeBlock[] = Array.from({ length: 150 }, (_, i) => ({ kind: "item", text: `fact ${i}`, ref: SHA, actions: [{ id: "memory.forget", label: "Forget", kind: "confirm" }] }));
  const view = renderHomeView([{ blocks: [{ kind: "heading", text: "What I remember about you" }, ...items] }], "Saved.");
  ok(view.blocks.length <= SLACK_HOME_MAX_BLOCKS, `a 150-item page stays within Slack's cap (rendered ${view.blocks.length})`);
  const last = JSON.stringify(view.blocks[view.blocks.length - 1]);
  ok(last.includes("This page is full"), "…and its last line says it was cut");
  ok(JSON.stringify(view.blocks[0]).includes("Saved."), "the notice renders first");
  const item = view.blocks.find((b) => b.type === "section" && (b as { accessory?: unknown }).accessory) as { accessory: { options: { value: string }[] } } | undefined;
  ok(item?.accessory.options[0]?.value === `memory.forget|${SHA}`, "an item's overflow option carries the action and the digest only");
  const short = renderHomeView([{ blocks: [{ kind: "text", text: "hi" }] }]);
  ok(!JSON.stringify(short).includes("This page is full"), "NEGATIVE: a short page is not marked cut");
}

console.log("§4 the viewer");
function fakeDeps(over: { member?: boolean | undefined; internal?: (c: string) => boolean; dm?: string | null } = {}): SlackHomeDeps & { calls: { method: string; body: Record<string, unknown> }[] } {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    call: async (method, body) => {
      calls.push({ method, body });
      if (method === "conversations.open") return over.dm === null ? { ok: false } : { ok: true, channel: { id: over.dm ?? "D_ALICE" } };
      if (method === "users.conversations") return { ok: true, channels: [{ id: "CPLAT" }, { id: "CSHARED" }, { id: "CBARE" }, { id: "CNONE" }] };
      return { ok: true };
    },
    authorIsMember: async () => ("member" in over ? over.member : true),
    channelInternal: async (c) => (over.internal ? over.internal(c) : true),
  };
}
{
  const internal = fakeDeps({ internal: (c) => c !== "CSHARED" });
  const v = await buildSlackHomeViewer({ userId: USER, teamId: TEAM }, internal);
  ok(v?.trust === "internal" && v.principalId.endsWith(USER), "a full member is internal, keyed to the SIGNED user id");
  ok(v?.personal?.surface === "D_ALICE" && v.personal.platform === "slack", "the personal partition is the person's OWN DM, resolved by conversations.open");
  ok(internal.calls.find((c) => c.method === "conversations.open")?.body.users === USER, "…opened for the signed user, never for an id a payload chose");
  ok(v?.domains.length === 1 && v.domains[0]!.domain.name === "platform", "the member is in the platform domain; a memory-less domain is not listed");
  ok(v?.domains[0]!.rooms.map((r) => r.nativeId).join() === "CPLAT", "🔴 the Slack Connect channel CSHARED is NOT a way in — only confirmed-internal rooms count");

  const guest = fakeDeps({ member: false });
  const g = await buildSlackHomeViewer({ userId: USER, teamId: TEAM }, guest);
  ok(g?.trust === "external" && g.domains.length === 0, "a guest is external and has no domains");
  ok(!guest.calls.some((c) => c.method === "users.conversations"), "…and no channel lookup is even made for them");
  const unknown = await buildSlackHomeViewer({ userId: USER, teamId: TEAM }, fakeDeps({ member: undefined }));
  ok(unknown?.trust === "external", "an UNRESOLVABLE membership is external (fail-closed)");
  const noDm = await buildSlackHomeViewer({ userId: USER, teamId: TEAM }, fakeDeps({ dm: null }));
  ok(noDm !== undefined && noDm.personal === undefined, "a DM that could not be opened leaves no personal partition — never a guessed one");

  const deps = fakeDeps();
  const handled = await handleHomeSubmission({ userId: USER, teamId: TEAM, action: "memory.forget", ref: SHA }, deps);
  ok(handled, "a forged forget still answers by republishing the page");
  const published = deps.calls.find((c) => c.method === "views.publish");
  ok(published?.body.user_id === USER && JSON.stringify(published.body.view).includes("nothing to forget"), "…to the SIGNED user, saying there was nothing to forget");
}

console.log("§5 the route");
{
  const SECRET = "home-secret";
  const NOW = 1_700_000_000_000;
  const signed = (body: string, ct: string): Request => {
    const ts = String(Math.floor(NOW / 1000));
    const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
    return new Request("https://oe.test/eve/v1/slack", { method: "POST", headers: { "content-type": ct, "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body });
  };
  const opened: string[] = [];
  const waits: Promise<unknown>[] = [];
  const handler = buildFrontHandler(async () => new Response("inner"), {
    signingSecret: SECRET,
    now: () => NOW,
    stampEventVerified: async () => undefined,
    handleHomeOpened: async (open) => {
      opened.push(`${open.teamId}/${open.userId}`);
      return true;
    },
  });
  const args = { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as never;
  const body = (team: string) => JSON.stringify({ type: "event_callback", team_id: team, event: { type: "app_home_opened", user: USER, tab: "home" } });
  const res = await handler(signed(body(TEAM), "application/json"), args);
  await Promise.all(waits);
  ok(res.status === 200 && (await res.text()) === "", "a signed Home open is acknowledged with an empty 200");
  ok(opened.join() === `${TEAM}/${USER}`, "…and the handler ran after it");

  registerSurfaces([defineSurface({ key: "slack/T1", trust: "internal" })]);
  await handler(signed(body("T_FOREIGN"), "application/json"), args);
  await Promise.all(waits);
  ok(opened.length === 1, "🔴 an UNADMITTED workspace's Home open is fenced — the page is never built");
  const drops = await getOperationalStore().readAudit({ org: "default", action: "surface.wake_dropped" });
  ok(drops.some((d) => (d.detail as { door?: string } | undefined)?.door === "home-open"), "…and the fence wrote its drop row naming the door");
  registerSurfaces([]);

  const rechecks: string[] = [];
  const evHandler = buildFrontHandler(async () => new Response("inner"), {
    signingSecret: SECRET,
    now: () => NOW,
    stampEventVerified: async () => undefined,
    markEventSeen: async () => false,
    getBotIdentity: async () => ({ userId: "UBOT" }),
    recheckChannelCanvas: async (input) => {
      rechecks.push(`${input.trigger}:${input.teamId}/${input.channelId}${input.joinedUserId ? `:${input.joinedUserId}` : ""}`);
    },
  });
  const joinBody = (user: string, team = TEAM) =>
    JSON.stringify({ type: "event_callback", team_id: team, event_id: `Ev${user}${team}`, event: { type: "member_joined_channel", channel: "CPLAT", channel_type: "G", user, team, event_ts: "1700159720.000100" } });
  await evHandler(signed(joinBody("U_GUEST"), "application/json"), args);
  await evHandler(signed(JSON.stringify({ type: "event_callback", team_id: TEAM, event: { type: "channel_shared", channel: "CPLAT", connected_team_id: "T_PARTNER", event_ts: "1700159720.000200" } }), "application/json"), args);
  await evHandler(signed(joinBody("UBOT"), "application/json"), args);
  await Promise.all(waits);
  ok(rechecks.join() === `member-joined:${TEAM}/CPLAT:U_GUEST,channel-shared:${TEAM}/CPLAT`, `a person joining and a share each recheck the canvas, and the bot's own join does not (got ${rechecks.join()})`);
  registerSurfaces([defineSurface({ key: "slack/T1", trust: "internal" })]);
  await evHandler(signed(joinBody("U_X", "T_FOREIGN"), "application/json"), args);
  await Promise.all(waits);
  registerSurfaces([]);
  ok(rechecks.length === 2, "an unadmitted workspace's join is fenced before the recheck");

  const unsigned = await handler(new Request("https://oe.test/eve/v1/slack", { method: "POST", headers: { "content-type": "application/json" }, body: body(TEAM) }), args);
  ok(unsigned.status === 401 && opened.length === 1, "NEGATIVE: an unsigned Home open is refused before classification");
}

console.log("§6 the canvas");
function canvasDeps(
  over: { existing?: string; creator?: string; internal?: (c: string) => boolean; members?: string[]; guests?: string[]; membersPaged?: boolean; editFails?: boolean; infoFails?: boolean; filesFails?: boolean; botUnknown?: boolean } = {},
): MemoryCanvasDeps & { calls: { method: string; body: Record<string, unknown> }[] } {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    now: () => new Date("2026-10-11T00:00:00Z"),
    channelInternal: async (c) => (over.internal ? over.internal(c) : true),
    authorIsMember: async (u) => (u === "U_UNKNOWN" ? undefined : !(over.guests ?? []).includes(u)),
    call: async (method, body) => {
      calls.push({ method, body });
      switch (method) {
        case "auth.test":
          return over.botUnknown ? { ok: false, error: "invalid_auth" } : { ok: true, team_id: TEAM, user_id: "UBOT" };
        case "users.conversations":
          return { ok: true, channels: [{ id: "CPLAT" }, { id: "CSHARED" }, { id: "CQUIET" }, { id: "COTHER" }] };
        case "conversations.info":
          return over.infoFails ? { ok: false, error: "ratelimited" } : { ok: true, channel: { id: body.channel, properties: over.existing ? { canvas: { file_id: over.existing } } : {} } };
        case "files.info":
          return over.filesFails ? { ok: false, error: "ratelimited" } : { ok: true, file: { id: body.file, user: over.creator } };
        case "conversations.members":
          return { ok: true, members: over.members ?? ["UBOT", USER], ...(over.membersPaged ? { response_metadata: { next_cursor: "more" } } : {}) };
        case "canvases.edit":
          return over.editFails ? { ok: false, error: "canvas_editing_failed" } : { ok: true };
        default:
          return { ok: true };
      }
    },
  };
}
{
  await providerById("sqlite").writeTier(
    { org: "default", platform: "x", workspace: "x", surface: "x", workspaceKey: "x/x", surfaceKey: "x/x/x", key: "x/x/x" },
    siloTier("platform-brain"),
    { "MEMORY.md": "# m\n\n## Decisions\n- Deploys freeze on Fridays <!channel>\n" },
    "seed",
  );
  const fresh = canvasDeps({ internal: (c) => c !== "CSHARED" });
  await refreshMemoryCanvases({ org: "default", silo: "platform-brain" }, fresh);
  const creates = fresh.calls.filter((c) => c.method === "conversations.canvases.create");
  ok(creates.length === 1 && creates[0]!.body.channel_id === "CPLAT", "a channel with no canvas gets one — and only the confirmed-internal channel");
  const md = JSON.stringify(creates[0]!.body.document_content);
  ok(md.includes("Deploys freeze on Fridays"), "the canvas holds the domain's lines");
  ok(!md.includes("<!channel>") && md.includes("‹!channel"), "…with a remembered `<!channel>` defused, so the canvas pings nobody");
  ok(
    !fresh.calls.some((c) => (c.method === "conversations.canvases.create" || c.method === "canvases.edit") && c.body.channel_id === "CSHARED"),
    "🔴 the Slack Connect channel never gets the domain's memory written into it (it is only looked at, to clear an app canvas — §6b)",
  );
  ok(!fresh.calls.some((c) => c.body.channel === "COTHER" || c.body.channel_id === "COTHER"), "a channel of no domain is never touched");
  const rows = await getOperationalStore().readAudit({ org: "default", action: "memory.canvas_refresh" });
  ok(rows.some((r) => (r.detail as { outcome?: string }).outcome === "created") && rows.some((r) => (r.detail as { outcome?: string }).outcome === "skipped-external"), "each channel visited writes a memory.canvas_refresh row with its outcome");

  const ours = canvasDeps({ existing: "F_CANVAS", creator: "UBOT" });
  ok((await publishChannelCanvas("CPLAT", "# x", "UBOT", ours)) === "updated", "the app's own canvas is replaced");
  const edit = ours.calls.find((c) => c.method === "canvases.edit");
  ok(edit?.body.canvas_id === "F_CANVAS" && JSON.stringify(edit.body.changes).includes('"operation":"replace"'), "…with one whole-document replace");

  const theirs = canvasDeps({ existing: "F_HUMAN", creator: "U_SOMEONE" });
  ok((await publishChannelCanvas("CPLAT", "# x", "UBOT", theirs)) === "skipped-foreign", "🔴 a canvas a PERSON made is never overwritten");
  ok(!theirs.calls.some((c) => c.method === "canvases.edit"), "…not one edit call is made");
  ok((await publishChannelCanvas("CPLAT", "# x", undefined, canvasDeps({ existing: "F_X", creator: "UBOT" }))) === "skipped-foreign", "an unknown bot identity owns nothing (fail-closed)");

  const guestRoom = canvasDeps({ members: ["UBOT", USER, "U_GUEST"], guests: ["U_GUEST"] });
  ok((await publishChannelCanvas("CPLAT", "# x", "UBOT", guestRoom, TEAM)) === "skipped-guest", "🔴 a channel with a guest member gets no canvas");
  ok(!guestRoom.calls.some((c) => c.method === "conversations.canvases.create" || c.method === "canvases.edit"), "…not one canvas write is made");
  ok((await publishChannelCanvas("CPLAT", "# x", "UBOT", canvasDeps({ members: ["UBOT", "U_UNKNOWN"] }), TEAM)) === "skipped-guest", "a member the lookup cannot resolve counts as a guest (fail-closed)");
  ok((await publishChannelCanvas("CPLAT", "# x", "UBOT", canvasDeps({ membersPaged: true }), TEAM)) === "skipped-guest", "a channel larger than one page is refused, never half-checked");
  ok((await publishChannelCanvas("CPLAT", "# x", "UBOT", canvasDeps({ members: ["UBOT", USER, "U_BOB"] }), TEAM)) === "created", "NEGATIVE CONTROL: an all-member channel still gets its canvas");

  const quiet = canvasDeps({ existing: "F_OURS", creator: "UBOT" });
  await refreshMemoryCanvases({ org: "default", silo: "quiet-brain" }, quiet);
  const quietEdits = quiet.calls.filter((c) => c.method === "canvases.edit");
  ok(quietEdits.length === 1 && JSON.stringify(quietEdits[0]!.body).includes("withdrawn"), "🔴 `memoryCanvas: false` takes the app's old canvas DOWN on the next write — it does not leave it up ungated");
  ok(!quiet.calls.some((c) => c.method === "conversations.canvases.create"), "…and never makes a canvas");
  const none = canvasDeps();
  await refreshMemoryCanvases({ org: "default", silo: "no-such-silo" }, none);
  ok(none.calls.length === 0, "a silo no domain names costs no Slack call at all");
  ok(defuseCanvasText("![](@U1) <@U2>") === "!\\[](@U1) ‹@U2>", "mention syntax is defused in both spellings");
}

console.log("§6b a failed gate clears the app's own canvas");
{
  const SECRETLINE = "# m\n- the launch date is 3 March";
  const editedMarkdown = (d: { calls: { method: string; body: Record<string, unknown> }[] }): string =>
    JSON.stringify(d.calls.filter((c) => c.method === "canvases.edit").map((c) => c.body.changes));

  const shared = canvasDeps({ existing: "F_OURS", creator: "UBOT", internal: () => false });
  ok((await publishChannelCanvas("CPLAT", SECRETLINE, "UBOT", shared, TEAM)) === "cleared-external", "🔴 the app's canvas in a channel that became SHARED is cleared, not skipped");
  ok(editedMarkdown(shared).includes("withdrawn") && !editedMarkdown(shared).includes("launch date"), "…replaced by a notice that carries no memory");
  ok(!shared.calls.some((c) => c.method === "conversations.canvases.create"), "…and no new canvas is made");

  const guest = canvasDeps({ existing: "F_OURS", creator: "UBOT", members: ["UBOT", USER, "U_GUEST"], guests: ["U_GUEST"] });
  ok((await publishChannelCanvas("CPLAT", SECRETLINE, "UBOT", guest, TEAM)) === "cleared-guest", "🔴 the app's canvas in a channel a GUEST joined is cleared");
  ok(!editedMarkdown(guest).includes("launch date"), "…with no memory line left on it");

  const theirs = canvasDeps({ existing: "F_HUMAN", creator: "U_SOMEONE", internal: () => false });
  ok((await publishChannelCanvas("CPLAT", SECRETLINE, "UBOT", theirs, TEAM)) === "skipped-external", "a canvas a PERSON made is left alone, even on a failed gate");
  ok(!theirs.calls.some((c) => c.method === "canvases.edit"), "…not one edit call");

  const refused = canvasDeps({ existing: "F_OURS", creator: "UBOT", internal: () => false, editFails: true });
  ok((await publishChannelCanvas("CPLAT", SECRETLINE, "UBOT", refused, TEAM)) === "clear-failed", "a clear Slack refuses says `clear-failed` — the memory may still be on screen — never a quiet skip");

  const passing = canvasDeps({ existing: "F_OURS", creator: "UBOT" });
  ok((await publishChannelCanvas("CPLAT", null, "UBOT", passing, TEAM)) === "unchanged", "NEGATIVE CONTROL: a recheck on a channel that still passes writes nothing");
  ok(!passing.calls.some((c) => c.method === "canvases.edit" || c.method === "conversations.info"), "…and does not even look up the canvas");

  const joined = canvasDeps({ existing: "F_OURS", creator: "UBOT", members: ["UBOT", USER, "U_GUEST"], guests: ["U_GUEST"] });
  const outcome = await recheckChannelCanvas({ org: "default", teamId: TEAM, channelId: "CPLAT", trigger: "member-joined" }, joined);
  ok(outcome === "cleared-guest", "a guest joining a domain channel clears the canvas at once");
  const rows = await getOperationalStore().readAudit({ org: "default", action: "memory.canvas_refresh" });
  ok(rows.some((r) => (r.detail as { trigger?: string; outcome?: string }).trigger === "member-joined" && (r.detail as { outcome?: string }).outcome === "cleared-guest"), "…and the row names the trigger and the outcome");
  const quietRoom = canvasDeps({ existing: "F_OURS", creator: "UBOT" });
  ok((await recheckChannelCanvas({ org: "default", teamId: TEAM, channelId: "CQUIET", trigger: "channel-shared" }, quietRoom)) === "cleared-disabled", "🔴 a share in a `memoryCanvas: false` channel takes the app's old canvas down");
  const strayRoom = canvasDeps({ existing: "F_OURS", creator: "UBOT" });
  ok((await recheckChannelCanvas({ org: "default", teamId: TEAM, channelId: "COTHER", trigger: "member-joined" }, strayRoom)) === "cleared-disabled", "🔴 …and so does a join in a channel that left every domain");
  const empty = canvasDeps();
  ok((await recheckChannelCanvas({ org: "default", teamId: TEAM, channelId: "COTHER", trigger: "member-joined" }, empty)) === "skipped-disabled", "NEGATIVE CONTROL: no canvas there, nothing written");
  ok(!empty.calls.some((c) => c.method === "canvases.edit" || c.method === "conversations.canvases.create"), "…not one write");
  const personsCanvas = canvasDeps({ existing: "F_HUMAN", creator: "U_SOMEONE" });
  ok((await recheckChannelCanvas({ org: "default", teamId: TEAM, channelId: "COTHER", trigger: "member-joined" }, personsCanvas)) === "skipped-disabled", "a person's canvas there is left alone");

  ok((await publishChannelCanvas("CPLAT", SECRETLINE, "UBOT", canvasDeps({ internal: () => false, infoFails: true }), TEAM)) === "clear-failed", "🔴 a failed conversations.info after a failed gate is `clear-failed`, never a skip");
  ok((await publishChannelCanvas("CPLAT", SECRETLINE, "UBOT", canvasDeps({ existing: "F_X", internal: () => false, filesFails: true }), TEAM)) === "clear-failed", "🔴 a failed files.info after a failed gate is `clear-failed`");
  ok((await publishChannelCanvas("CPLAT", SECRETLINE, undefined, canvasDeps({ existing: "F_X", creator: "UBOT", internal: () => false }), TEAM)) === "clear-failed", "🔴 an unknown bot identity after a failed gate is `clear-failed`");
  ok((await recheckChannelCanvas({ org: "default", teamId: TEAM, channelId: "CPLAT", trigger: "channel-shared" }, canvasDeps({ existing: "F_X", creator: "UBOT", internal: () => false, botUnknown: true }))) === "clear-failed", "…including when auth.test failed in the recheck");

  const lagging = canvasDeps({ existing: "F_OURS", creator: "UBOT", members: ["UBOT", USER], guests: ["U_NEWGUEST"] });
  ok(
    (await recheckChannelCanvas({ org: "default", teamId: TEAM, channelId: "CPLAT", trigger: "member-joined", joinedUserId: "U_NEWGUEST" }, lagging)) === "cleared-guest",
    "🔴 a guest the member list does not show yet still takes the canvas down — the joiner is probed directly",
  );
  const memberJoins = canvasDeps({ existing: "F_OURS", creator: "UBOT", members: ["UBOT", USER] });
  ok(
    (await recheckChannelCanvas({ org: "default", teamId: TEAM, channelId: "CPLAT", trigger: "member-joined", joinedUserId: "U_BOB" }, memberJoins)) === "unchanged",
    "NEGATIVE CONTROL: a full member joining changes nothing",
  );

  let extShared = false;
  const infoFetch = (async (url: unknown) => {
    const method = String(url).split("/").pop() ?? "";
    const json = method === "conversations.info" ? { ok: true, channel: { id: "CFRESH", is_channel: true, is_ext_shared: extShared, is_shared: extShared, is_org_shared: false, is_pending_ext_shared: false } } : { ok: true };
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json), headers: new Headers() } as unknown as Response;
  }) as unknown as typeof fetch;
  await withPatchedFetch(infoFetch, async () => {
    ok((await confirmChannelInternal("CFRESH")) === true, "fresh-read setup: the channel starts internal, and the verdict is cached");
    extShared = true;
    ok((await confirmChannelInternal("CFRESH")) === true, "fresh-read setup: the CACHED read still says internal after the share");
    ok((await confirmChannelInternalFresh("CFRESH")) === false, "🔴 the canvas's fresh read sees the share at once");
  });
  ok(liveMemoryCanvasDeps().channelInternal === confirmChannelInternalFresh, "🔴 the LIVE canvas deps use the fresh read, never the wake path's cached one");
}

console.log("§7 the boot entry wires the canvas to the write road");
{
  const methods: string[] = [];
  const fake = (async (url: unknown, init?: { body?: unknown }) => {
    const method = String(url).split("/").pop() ?? "";
    methods.push(method);
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    const json =
      method === "auth.test"
        ? { ok: true, team_id: TEAM, user_id: "UBOT" }
        : method === "users.conversations"
          ? { ok: true, channels: [{ id: "CPLAT" }] }
          : method === "conversations.info"
            ? { ok: true, channel: { id: body.channel, is_ext_shared: false, is_shared: false, is_org_shared: false, properties: {} } }
            : method === "conversations.members"
              ? { ok: true, members: ["UBOT", "U_WIRE_MEMBER"] }
              : method === "users.info"
                ? { ok: true, user: { id: body.user, team_id: TEAM, is_restricted: false, is_ultra_restricted: false, is_stranger: false, deleted: false } }
                : { ok: true };
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json), headers: new Headers() } as unknown as Response;
  }) as unknown as typeof fetch;
  await withPatchedFetch(fake, async () => {
    await writeMemoryTier({
      provider: providerById("sqlite"),
      partition: { org: "default", platform: "slack", workspace: TEAM, surface: "CPLAT", workspaceKey: "slack/T1", surfaceKey: "slack/T1/CPLAT", key: "slack/T1/CPLAT" },
      tier: siloTier("platform-brain"),
      files: { "MEMORY.md": "# m\n\n## Decisions\n- Deploys freeze on Fridays\n- Rollbacks need two reviewers\n" },
      message: "t",
      silo: { name: "platform-brain", provider: "sqlite" },
      road: "session-persist",
    });
  });
  ok(methods.includes("conversations.canvases.create"), `a silo write through core's one road reached Slack's canvas API (calls: ${methods.join(", ")})`);
}

console.log("§8 the DM question's membership probe");
{
  const probeOf = (deps: SlackHomeDeps) => slackDomainMembershipProbe(deps);
  const member = fakeDeps({ internal: (c) => c !== "CSHARED" });
  const a = await probeOf(member)({ principalId: USER, workspaceKey: "slack/T1" });
  const rooms = a.rooms.map((r) => `${r.domain}:${r.surfaceKey}`).sort();
  ok(a.fullMember && JSON.stringify(rooms) === JSON.stringify(["bare:slack/T1/CBARE", "platform:slack/T1/CPLAT"]), `a member's internal domain rooms are reported, a memory-less domain included (got ${JSON.stringify(rooms)})`);
  ok(!rooms.includes("platform:slack/T1/CSHARED"), "🔴 NEGATIVE: a channel Slack does not confirm internal is no route into a domain");
  ok(a.rooms.find((r) => r.surfaceKey === "slack/T1/CPLAT")?.origin.platform === "slack" && (a.rooms.find((r) => r.surfaceKey === "slack/T1/CPLAT")!.origin as { channelId: string }).channelId === "CPLAT", "each room carries its top-level reply target");
  const guest = fakeDeps({ member: false });
  const g = await probeOf(guest)({ principalId: USER, workspaceKey: "slack/T1" });
  ok(!g.fullMember && g.rooms.length === 0, "🔴 NEGATIVE: a guest belongs to no domain");
  ok(!guest.calls.some((c) => c.method === "users.conversations"), "…and costs no channel lookup");
  const unknown = fakeDeps({ member: undefined });
  ok(!(await probeOf(unknown)({ principalId: USER, workspaceKey: "slack/T1" })).fullMember, "🔴 NEGATIVE: an account whose membership lookup failed is not a full member (fail-closed)");
  const lookedUp = fakeDeps();
  await probeOf(lookedUp)({ principalId: USER, workspaceKey: "slack/T1" });
  ok(lookedUp.calls.find((c) => c.method === "users.conversations")?.body.user === USER, "the channel walk is for the asking person, never another id");
  ok((await probeOf(fakeDeps())({ principalId: USER, workspaceKey: "discord/G1" })).rooms.length === 0, "NEGATIVE: a workspace key on another platform reports nothing");
  ok(typeof domainMembershipProbe("slack") === "function", "the boot entry registers the probe as Slack's DomainMembershipProbe");
  ok(domainMembershipProbe("no-such-platform") === undefined, "NEGATIVE: a platform that registered no probe has none (the DM question refuses there)");
}

console.log(`\n✓ slack-home: ${n} assertions passed`);
