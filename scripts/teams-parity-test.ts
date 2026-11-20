import assert from "node:assert/strict";
import { rmSync as __rmSuiteStore } from "node:fs";
import { join as __joinSuiteStore } from "node:path";
import { tmpdir as __tmpdirSuiteStore } from "node:os";
const __suiteStoreDir = __joinSuiteStore(__tmpdirSuiteStore(), `open-everywhere-suite-teams-parity-${process.pid}`);
__rmSuiteStore(__suiteStoreDir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = __joinSuiteStore(__suiteStoreDir, "ops.sqlite3");

const { parseTeamsActivity } = await import("@open-everywhere/provider-teams/agent/channels/teams-inbound.js");
type TeamsMessageActivity = import("eve/channels/teams").TeamsMessageActivity;
type TeamsConversationUpdateActivity = import("eve/channels/teams").TeamsConversationUpdateActivity;
const { registerTeamsProvider } = await import("@open-everywhere/provider-teams/agent/register.js");
const { buildTeamsAuth } = await import("@open-everywhere/provider-teams/agent/channels/teams-identity.js");
const { teamsOnMessage } = await import("@open-everywhere/provider-teams/agent/channels/teams.js");
const { buildTeamsFrontHandler, liveTeamsOeCommand } = await import("@open-everywhere/provider-teams/agent/channels/teams-front.js");
const { COMMAND_FAILED_TEXT, PersonFacingError } = await import("@open-everywhere/core/agent/adapter-api.js");
type TeamsFrontPlan = import("@open-everywhere/provider-teams/agent/channels/teams-front.js").TeamsFrontPlan;
const { teamsNameDropCandidate, resolveTeamsNameDrop, teamsNativeAdmits } = await import("@open-everywhere/provider-teams/agent/channels/teams-name-drop.js");
const { parseTeamsOeCommand } = await import("@open-everywhere/provider-teams/agent/channels/teams-commands.js");
const { parseTeamsBotAdded, teamsChannelIntro, teamsFirstContactTarget, teamsIntroPartition } = await import("@open-everywhere/provider-teams/agent/channels/teams-intro.js");
const { handleTeamsSingleWindowDispatch } = await import("@open-everywhere/provider-teams/agent/channels/teams-supervisor.js");
const { teamsAppManifestTemplate } = await import("@open-everywhere/provider-teams/agent/app-manifest.js");
const { teamsOwnCardRoom } = await import("@open-everywhere/provider-teams/agent/approvals/teams-flow.js");
const { TEAMS_SURFACE_PARITY } = await import("@open-everywhere/provider-teams/agent/surface-parity.js");
const core = await import("@open-everywhere/core/agent/adapter-api.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
const { approvalVenueFor } = await import("@open-everywhere/core/agent/approvals/card-venue.js");
const { runBudgetRaise, runStop } = await import("@open-everywhere/core/agent/commands/core.js");
type RequestApprovalInput = import("@open-everywhere/core/agent/approvals/flow.js").RequestApprovalInput;
type Partition = import("@open-everywhere/core/agent/adapter-api.js").Partition;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

registerTeamsProvider();

const TENANT = "TENANT_P";
const BOT = "28:parity-bot";
const BOT_NAME = "Parity Helper";
const HUMAN = "29:parity-human";
const SERVICE_URL = "https://smba.trafficmanager.net/uk/";
const CHAN_ON = "19:chan-namedrop-on@thread.tacv2";
const CHAN_OFF = "19:chan-namedrop-off@thread.tacv2";
const GROUP_CONV = "19:group-chat@thread.v2";
const PERSONAL_CONV = "a:1personal-chat";
const TEAM = "19:team-parity@thread.tacv2";
const WIDE_TENANT = "TENANT_W";

const seg = (id: string): string => core.surfaceKeySegment(id);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({ name: "loud", reach: [`teams/${TENANT}/${seg(CHAN_ON)}`], nameDropWake: true }),
    defineDomain({ name: "quiet", reach: [`teams/${TENANT}/${seg(CHAN_OFF)}`] }),
    defineDomain({ name: "wide", reach: [`teams/${WIDE_TENANT}`] }),
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

type Scope = "channel" | "groupChat" | "personal";

function message(opts: { scope?: Scope; channel?: string; text: string; mentioned?: boolean; id?: string; from?: string; botName?: string | null }): TeamsMessageActivity {
  const scope = opts.scope ?? "channel";
  const channel = opts.channel ?? CHAN_ON;
  const id = opts.id ?? `act-${Math.random().toString(36).slice(2, 8)}`;
  const conversationId = scope === "channel" ? `${channel};messageid=${id}` : scope === "groupChat" ? GROUP_CONV : PERSONAL_CONV;
  const mentionText = `<at>${BOT_NAME}</at>`;
  const body = {
    type: "message",
    channelId: "msteams",
    id,
    serviceUrl: SERVICE_URL,
    from: { id: opts.from ?? HUMAN, name: "Parity Human" },
    recipient: opts.botName === null ? { id: BOT } : { id: BOT, name: opts.botName ?? BOT_NAME },
    conversation: { id: conversationId, conversationType: scope, tenantId: TENANT },
    channelData: scope === "channel" ? { tenant: { id: TENANT }, team: { id: TEAM }, channel: { id: channel } } : { tenant: { id: TENANT } },
    text: opts.mentioned ? `${mentionText} ${opts.text}` : opts.text,
    entities: opts.mentioned ? [{ type: "mention", text: mentionText, mentioned: { id: BOT, name: BOT_NAME } }] : [],
  };
  const parsed = parseTeamsActivity(body);
  assert.ok(parsed && parsed.type === "message");
  return parsed as TeamsMessageActivity;
}

function partitionOf(a: TeamsMessageActivity): Partition {
  const auth = buildTeamsAuth({
    userId: a.from.id,
    tenantId: a.tenantId ?? a.conversation.tenantId,
    conversationId: a.conversation.id,
    channelId: a.teamsChannelId,
    teamId: a.teamId,
    serviceUrl: a.serviceUrl,
    scope: a.scope,
  });
  return core.resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
}

{
  const base = { scope: "channel", isBotMentioned: false, machineAuthored: false, botName: BOT_NAME };
  ok(teamsNameDropCandidate({ ...base, text: "can parity helper look at the build?" }), "name-drop: a channel message that names the bot (any case) is a candidate");
  ok(!teamsNameDropCandidate({ ...base, text: "can someone look at the build?" }), "name-drop: a message that names nobody is NOT a candidate (negative control)");
  ok(!teamsNameDropCandidate({ ...base, text: "ParityHelperBot is a different word" }), "name-drop: the name inside a longer word is not a match");
  ok(!teamsNameDropCandidate({ ...base, isBotMentioned: true, text: "Parity Helper hi" }), "name-drop: an @mention is the addressed leg's, never a name-drop");
  ok(!teamsNameDropCandidate({ ...base, machineAuthored: true, text: "Parity Helper hi" }), "name-drop: a machine author never name-drops");
  ok(!teamsNameDropCandidate({ ...base, scope: "groupChat", text: "Parity Helper hi" }), "name-drop: a group chat is not a candidate — channels only, the Slack rule");
  ok(!teamsNameDropCandidate({ ...base, scope: "personal", text: "Parity Helper hi" }), "name-drop: a personal chat is not a candidate");
  ok(!teamsNameDropCandidate({ scope: "channel", isBotMentioned: false, machineAuthored: false, text: "Parity Helper hi" }), "name-drop: no bot name ⇒ never a candidate (fail closed)");

  const woke: unknown[] = [];
  const silent: unknown[] = [];
  const deps = {
    woke: (async (key: unknown, _reason: string, opts: unknown) => void woke.push({ key, opts })) as never,
    silent: (async (key: unknown, reason: string) => void silent.push({ key, reason })) as never,
  };
  const on = message({ text: "is Parity Helper around to check the deploy?" });
  ok((await resolveTeamsNameDrop(on, partitionOf(on), "native", deps)) === true, "name-drop: an enabled domain ADMITS the name-drop");
  ok(woke.length === 1 && silent.length === 0, "name-drop: the admit writes ONE woke row and no silent row");
  const wokeRow = woke[0] as { key: { surface: string; container: string; ts: string }; opts: { road: string; via: string } };
  ok(wokeRow.key.surface === `teams/${TENANT}/${seg(CHAN_ON)}`, `name-drop: the row's surface is the DOMAIN-grain key every Teams front row carries (got ${wokeRow.key.surface})`);
  ok(wokeRow.key.container === on.conversation.id && wokeRow.key.ts === on.id, "name-drop: the row names the conversation and the activity id");
  ok(wokeRow.opts.road === "native" && wokeRow.opts.via === "built-in", "name-drop: the row names the road and the built-in policy");
  const off = message({ channel: CHAN_OFF, text: "is Parity Helper around?" });
  ok((await resolveTeamsNameDrop(off, partitionOf(off), "native", deps)) === false, "name-drop: a domain that did not opt in REFUSES — fail-closed OFF");
  ok(silent.length === 1 && woke.length === 1, "name-drop: the refused candidate writes ONE silent row");
  const control = message({ text: "is anyone around?" });
  ok((await resolveTeamsNameDrop(control, partitionOf(control), "native", deps)) === false && woke.length === 1 && silent.length === 1, "name-drop: a message that names nobody writes NO row at all (the volume bound)");
  const relayless = message({ text: "is Parity Helper around?", botName: null });
  ok(
    (await resolveTeamsNameDrop(relayless, partitionOf(relayless), "native", { ...deps, botName: async () => BOT_NAME })) === true,
    "name-drop: with no relayed recipient name, the Graph-resolved name is the fallback",
  );

  const neverEngaged = { engaged: async () => false };
  ok(await teamsNativeAdmits(message({ scope: "personal", text: "hi" }), { ...neverEngaged, nameDrop: async () => false }), "native gate: a personal chat is always admitted");
  ok(await teamsNativeAdmits(message({ mentioned: true, text: "hi" }), { ...neverEngaged, nameDrop: async () => false }), "native gate: an @mention is admitted");
  ok(await teamsNativeAdmits(message({ text: "hi" }), { engaged: async () => true, nameDrop: async () => false }), "native gate: an engaged follow-up is admitted");
  ok(await teamsNativeAdmits(message({ text: "hi" }), { ...neverEngaged, nameDrop: async () => true }), "native gate: a name-drop is admitted");
  ok(!(await teamsNativeAdmits(message({ text: "hi" }), { ...neverEngaged, nameDrop: async () => false })), "native gate: anything else is dropped");

  const ctx = { teams: { request: async () => ({ ok: false, body: {} }) }, thread: { post: async () => ({ id: "p" }) }, isSubscribed: async () => false };
  const nativeOn = await teamsOnMessage(ctx as never, message({ text: "Parity Helper, is the deploy green?" }));
  ok(nativeOn !== null && (nativeOn as { auth?: unknown }).auth !== undefined, "native road: the REAL teamsOnMessage admits a name-drop on an enabled domain (returns {auth})");
  ok((await teamsOnMessage(ctx as never, message({ channel: CHAN_OFF, text: "Parity Helper, is the deploy green?" }))) === null, "native road: the same name-drop on a domain that did not opt in runs no turn");
  ok((await teamsOnMessage(ctx as never, message({ text: "is the deploy green?" }))) === null, "native road: a plain message that names nobody runs no turn (negative control)");

  const rendered: string[] = [];
  const dispatch = async (nameDrop: boolean): Promise<string> => {
    await handleTeamsSingleWindowDispatch(
      {
        surfaceKey: `teams/${TENANT}/${seg(CHAN_ON)}`,
        containerKey: `teams/${TENANT}/${seg(CHAN_ON)}`,
        channelId: CHAN_ON,
        auth: buildTeamsAuth({ userId: HUMAN, tenantId: TENANT, conversationId: CHAN_ON, scope: "channel" }),
        ingested: [],
        trigger: { id: "t1", authorId: HUMAN, authorName: "Parity Human", sentAt: new Date().toISOString(), text: "Parity Helper, check this", trust: "member" as never },
        ...(nameDrop ? { nameDrop: true } : {}),
        window: { wakeId: core.mintWakeId(), origin: { platform: "teams", serviceUrl: SERVICE_URL, conversationId: CHAN_ON } },
      } as never,
      {
        getOrCreateSession: async () => ({ token: "tok", generation: 1, freshGeneration: false, tail: [] }),
        wake: async ({ message: m }) => void rendered.push(m),
      },
    );
    return rendered[rendered.length - 1] ?? "";
  };
  const asNameDrop = await dispatch(true);
  ok(asNameDrop.includes('addressing="name-drop"'), `seat road: an admitted name-drop renders addressing="name-drop" (got ${asNameDrop.slice(0, 200)})`);
  ok(asNameDrop.includes('follow-up="channel-not-following"'), "seat road: the name-drop states the channel-not-following contract — a Teams name-drop engages no chain");
  const asWatch = await dispatch(false);
  ok(asWatch.includes('addressing="channel-watch"') && !asWatch.includes("name-drop"), "seat road: without the name-drop the same message stays channel-watch (negative control)");

  ok(
    typeof TEAMS_SURFACE_PARITY["name-drop-mention"] === "object" && "supported" in TEAMS_SURFACE_PARITY["name-drop-mention"],
    "parity: the Teams name-drop cell is a SUPPORTED cell with its tenant-consent note",
  );
}

{
  ok(parseTeamsOeCommand("/oe status", false)?.kind === "status", "/oe: the slash spelling is a command even unaddressed");
  ok(parseTeamsOeCommand("/OE budget raise 25", false)?.kind === "budget-raise", "/oe: the namespace match is case-insensitive");
  ok(parseTeamsOeCommand("/oe", false)?.kind === "help", "/oe: a bare slash namespace is help");
  ok(parseTeamsOeCommand("/oe frobnicate", false)?.kind === "error", "/oe: an unknown verb under the slash answers core's own error");
  ok(parseTeamsOeCommand("oe status", true)?.kind === "status", "/oe: the bare spelling is a command on an ADDRESSED message");
  ok(parseTeamsOeCommand("oe status", false) === null, "/oe: the bare spelling is NOT a command unaddressed — ordinary room chatter");
  ok(parseTeamsOeCommand("oe, can you look at the build", true) === null, "/oe: a bare spelling with an unknown verb is a question, not a command");
  ok(parseTeamsOeCommand("oe", true) === null, "/oe: the bare namespace alone is not a command");
  ok(parseTeamsOeCommand("what does /oe status do?", true) === null, "/oe: a command named mid-sentence is not a command");
  ok(parseTeamsOeCommand("/ops status", false, "ops")?.kind === "status" && parseTeamsOeCommand("/oe status", false, "ops") === null, "/oe: the namespace is the configured identity.commandName");

  async function drive(a: TeamsMessageActivity, opts: { seen?: Set<string>; gated?: boolean } = {}) {
    const calls = { forward: 0, command: [] as string[], seam: 0, dm: 0, plan: 0, dispatch: 0 };
    const handler = buildTeamsFrontHandler(
      async () => {
        calls.forward++;
        return new Response("native");
      },
      {
        verify: async () => JSON.stringify(a.raw),
        externalGate: async () => opts.gated === true,
        markEventSeen: async (_org, key) => (opts.seen ? (opts.seen.has(key) ? false : (opts.seen.add(key), true)) : true),
        engagementSeam: async () => {
          calls.seam++;
          return { kind: "hold", reason: "test", stopped: false } as never;
        },
        dmDivert: async () => void calls.dm++,
        planFor: () => {
          calls.plan++;
          return null;
        },
        dispatch: async () => void calls.dispatch++,
        oeCommand: async (_a, command) => void calls.command.push(command.kind),
        firstContactIntro: async () => ({ posted: false, reason: "test" }),
      },
    );
    const waits: Promise<unknown>[] = [];
    const res = await handler(new Request("https://x/eve/v1/teams", { method: "POST" }), { to: {} as never, waitUntil: (p: Promise<unknown>) => waits.push(p), attachSession: undefined } as never);
    await Promise.all(waits);
    return { res, calls };
  }
  const chan = await drive(message({ text: "/oe status" }));
  ok(chan.calls.command.join() === "status", "front: a channel `/oe status` runs the command");
  ok(chan.calls.forward === 0 && chan.calls.seam === 0 && chan.calls.plan === 0 && chan.calls.dispatch === 0, "front: …and nothing else — no forward, no engagement seam, no plan, no dispatch (zero inference)");
  const dm = await drive(message({ scope: "personal", text: "oe budget" }));
  ok(dm.calls.command.join() === "budget-status" && dm.calls.dm === 0, "front: a personal-chat `oe budget` runs the command and is NOT diverted to the DM window");
  const mention = await drive(message({ mentioned: true, text: "oe help" }));
  ok(mention.calls.command.join() === "help", "front: an @mention with the bare spelling (what a manifest pick inserts) runs the command");
  const chatter = await drive(message({ text: "oe status" }));
  ok(chatter.calls.command.length === 0 && chatter.calls.seam === 1, "front: unaddressed `oe status` is ordinary chatter — it reaches the seam, not the runner (negative control)");
  const gated = await drive(message({ text: "/oe budget raise 5" }), { gated: true });
  ok(gated.calls.command.length === 0 && gated.calls.forward === 0, "front: an author the external-participant gate suppresses runs NO command (the intercept sits below the gate)");
  const botAuthored = await drive(message({ text: "/oe status", from: "28:another-bot" }));
  ok(botAuthored.calls.command.length === 0, "front: a machine author runs NO command (the intercept sits below the author gate)");
  const seen = new Set<string>();
  const once = message({ text: "/oe budget raise 5", id: "redeliver-1" });
  const first = await drive(once, { seen });
  const replay = await drive(once, { seen });
  ok(first.calls.command.length === 1 && replay.calls.command.length === 0, "front: a Bot Framework redelivery of `/oe budget raise` runs it ONCE");

  const posted: { conversationId: string; text: string }[] = [];
  const send = async (input: { conversationId: string; body: unknown }) => void posted.push({ conversationId: input.conversationId, text: (input.body as { text: string }).text });
  const asked = message({ text: "/oe help" });
  const commandRows: { action: string; detail?: Record<string, unknown> }[] = [];
  await liveTeamsOeCommand(asked, { kind: "help" }, undefined, { send, probeFor: () => undefined, audit: (async (e: { action: string; detail?: Record<string, unknown> }) => void commandRows.push(e)) as never });
  ok(commandRows.length === 1 && commandRows[0]!.action === "teams.oe_command" && commandRows[0]!.detail?.command === "help", "runner: the command writes ONE teams.oe_command row with its kind");
  ok(posted.length === 1 && posted[0]!.conversationId === asked.conversation.id && posted[0]!.text.includes("/oe status"), "runner: `/oe help` posts core's help text into the asking reply chain");
  await liveTeamsOeCommand(asked, { kind: "budget-raise", usd: 5 }, undefined, {
    send,
    probeFor: () => undefined,
    run: async () => {
      throw new PersonFacingError("Try this in a channel instead.");
    },
  });
  ok(posted[1]?.text === "Try this in a channel instead.", "runner: a thrown PersonFacingError posts its own message verbatim");
  await liveTeamsOeCommand(asked, { kind: "budget-raise", usd: 5 }, undefined, {
    send,
    probeFor: () => undefined,
    run: async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
    },
  });
  ok(posted[2]?.text === COMMAND_FAILED_TEXT, "runner: a raw error posts the generic line, never its message");
  const beforeCard = posted.length;
  await liveTeamsOeCommand(asked, { kind: "budget-clear" }, undefined, { send, probeFor: () => undefined, run: async () => "" });
  ok(posted.length === beforeCard, "🔴 runner: an empty answer posts nothing beside the card");

  const manifest = JSON.parse(teamsAppManifestTemplate()) as { version: string; bots: { commandLists?: { scopes: string[]; commands: { title: string; description: string }[] }[] }[] };
  const lists = manifest.bots[0]!.commandLists ?? [];
  ok(lists.length === 1 && lists[0]!.scopes.join() === "team,groupChat,personal", "manifest: one commandLists entry covers all three scopes");
  const titles = lists[0]!.commands.map((c) => c.title);
  ok(titles.join("|") === "oe help|oe status|oe budget|oe stop", `manifest: the suggested titles are the bare spelling (got ${titles.join("|")})`);
  ok(titles.every((t) => t.length <= 32) && lists[0]!.commands.every((c) => c.description.length <= 128), "manifest: every title and description fits Teams' limits");
  ok(titles.every((t) => { const c = parseTeamsOeCommand(t, true); return c !== null && c.kind !== "error"; }), "manifest: every suggestion parses as a command when picked on an addressed message");
  ok(manifest.version !== "1.0.3", "manifest: the version moved past 1.0.3 so an existing install picks the command list up");
  const renamed = JSON.parse(teamsAppManifestTemplate({ commandName: "ops" })) as typeof manifest;
  ok(renamed.bots[0]!.commandLists![0]!.commands[0]!.title === "ops help", "manifest: the suggestions follow the configured command namespace");

  const chain = `${CHAN_ON};messageid=root-1`;
  const binding = core.bindFrom({ channel: { kind: "teams" }, session: { auth: { current: buildTeamsAuth({ userId: HUMAN, tenantId: TENANT, conversationId: chain, channelId: CHAN_ON, teamId: TEAM, serviceUrl: SERVICE_URL, scope: "channel" }) } } });
  await core.getOperationalStore().putTurnAnchor(
    binding.org,
    { windowKey: "parity-window", channelKey: core.turnChannelKey("teams", chain), sessionId: "parity-session", turnId: "parity-turn", surfaceKey: `teams/${TENANT}/${seg(chain)}` },
    new Date().toISOString(),
    core.TURN_ANCHOR_TTL_MS,
  );
  const attached: string[] = [];
  const stopped = await runStop(binding, ((sessionId: string) => {
    attached.push(sessionId);
    return { cancel: async () => ({ status: "accepted" }) };
  }) as never);
  ok(attached.join() === "parity-session", `/oe stop: the command found the turn anchored on the REPLY CHAIN (attached ${JSON.stringify(attached)}; said: ${stopped})`);
  ok(stopped.startsWith("Standing down"), "/oe stop: …and asked it to stand down");
}

{
  const update = (members: readonly string[], opts: { conversationType?: string; membershipType?: string } = {}): TeamsConversationUpdateActivity => {
    const parsed = parseTeamsActivity({
      type: "conversationUpdate",
      channelId: "msteams",
      id: "cu-1",
      serviceUrl: SERVICE_URL,
      from: { id: HUMAN },
      recipient: { id: BOT, name: BOT_NAME },
      conversation: { id: CHAN_ON, conversationType: opts.conversationType ?? "channel", tenantId: TENANT },
      channelData: { tenant: { id: TENANT }, team: { id: TEAM }, channel: { id: CHAN_ON, ...(opts.membershipType ? { membershipType: opts.membershipType } : {}) }, eventType: "teamMemberAdded" },
      membersAdded: members.map((id) => ({ id })),
    });
    assert.ok(parsed && parsed.type === "conversationUpdate");
    return parsed as TeamsConversationUpdateActivity;
  };
  const added = parseTeamsBotAdded(update([BOT]));
  ok(added !== null && added.conversationId === CHAN_ON && added.scope === "channel" && added.botName === BOT_NAME, "intro: a conversationUpdate that adds THIS bot is the join signal");
  ok(parseTeamsBotAdded(update([HUMAN])) === null, "intro: an update that adds someone else is not (negative control)");

  const marked = new Set<string>();
  const claimed = new Set<string>();
  const introRows: { action: string; detail?: Record<string, unknown> }[] = [];
  const sent: { conversationId: string; text: string }[] = [];
  const deps = {
    isOnboarded: async (p: Partition) => marked.has(p.surfaceKey),
    markOnboarded: async (p: Partition) => void marked.add(p.surfaceKey),
    send: async (input: { conversationId: string; body: unknown }) => void sent.push({ conversationId: input.conversationId, text: (input.body as { text: string }).text }),
    silenced: () => false,
    claim: async (_org: string, key: string) => (claimed.has(key) ? false : (claimed.add(key), true)),
    audit: (async (e: { action: string; detail?: Record<string, unknown> }) => void introRows.push(e)) as never,
  };
  const join = await teamsChannelIntro(added!, "join", deps);
  ok(introRows.length === 1 && introRows[0]!.action === "teams.intro_posted" && introRows[0]!.detail?.door === "join", "intro: the post writes ONE teams.intro_posted row naming the join door");
  ok(join.posted === true && sent.length === 1 && sent[0]!.conversationId === CHAN_ON, "intro: the join posts the intro into the channel");
  ok(sent[0]!.text.includes(BOT_NAME) && sent[0]!.text.startsWith("👋"), "intro: the copy is core's introMessage, under the bot's relayed name");
  const mention = teamsFirstContactTarget(message({ mentioned: true, text: "hi" }))!;
  ok(teamsIntroPartition(mention).surfaceKey === teamsIntroPartition(added!).surfaceKey, "intro: both doors key the marker on ONE channel-grain partition");
  const again = await teamsChannelIntro(mention, "first-contact", deps);
  ok(again.posted === false && sent.length === 1, "intro: a channel the join introduced is not introduced again on first contact");
  const other = teamsFirstContactTarget(message({ channel: CHAN_OFF, mentioned: true, text: "hi" }))!;
  const firstContact = await teamsChannelIntro(other, "first-contact", deps);
  ok(introRows.length === 2 && introRows[1]!.detail?.door === "first-contact", "intro: the first-contact post's row names its door");
  ok(firstContact.posted === true && sent.length === 2 && sent[1]!.conversationId === CHAN_OFF, "intro: the first @mention in another channel introduces the agent there, as a NEW channel post — never inside the asking chain");
  ok(teamsFirstContactTarget(message({ text: "hi" })) === null && teamsFirstContactTarget(message({ scope: "groupChat", mentioned: true, text: "hi" })) === null, "intro: a plain message and a group chat are not first-contact doors");
  ok((await teamsChannelIntro({ ...added!, scope: "groupChat" }, "join", deps)).posted === false, "intro: a group chat gets no intro — channels only, the Slack rule");
  ok((await teamsChannelIntro({ ...added!, membershipType: "shared", conversationId: "19:shared@thread.tacv2" }, "join", deps)).posted === false, "intro: a SHARED channel gets no intro");
  ok((await teamsChannelIntro({ ...added!, conversationId: "19:silenced@thread.tacv2" }, "join", { ...deps, silenced: () => true })).posted === false, "intro: a room the external policy silences gets no intro");
  const racing = { ...added!, conversationId: "19:racing@thread.tacv2" };
  const before = sent.length;
  const [r1, r2] = await Promise.all([teamsChannelIntro(racing, "join", { ...deps, isOnboarded: async () => false }), teamsChannelIntro(racing, "first-contact", { ...deps, isOnboarded: async () => false })]);
  ok([r1, r2].filter((r) => r.posted).length === 1 && sent.length === before + 1, "intro: two concurrent first deliveries post ONE intro — the atomic claim decides");
  const claimDown = await teamsChannelIntro({ ...added!, conversationId: "19:claimdown@thread.tacv2" }, "join", {
    ...deps,
    claim: async () => {
      throw new Error("store down");
    },
  });
  ok(claimDown.posted === false && sent.length === before + 1, "intro: a claim the store cannot take posts NOTHING (fail closed)");
  const failing = await teamsChannelIntro({ ...added!, conversationId: "19:nomarker@thread.tacv2" }, "join", {
    ...deps,
    markOnboarded: async () => {
      throw new Error("store down");
    },
  });
  ok(failing.posted === false && sent.length === before + 1, "intro: a marker that cannot be claimed posts NOTHING — fail-closed, or every mention would re-introduce");

  {
    const { teamsReplyChainSurface } = await import("../packages/core/scripts/e2e/teams-driver.js");
    const { teamsSegment } = await import("../packages/core/scripts/e2e/fixture-inventory-lib.js");
    const root = "1760781234567";
    const inChain = core.resolvePartition({
      channel: { kind: "teams" },
      session: { auth: { current: buildTeamsAuth({ userId: HUMAN, tenantId: TENANT, conversationId: `${CHAN_ON};messageid=${root}`, channelId: CHAN_ON, teamId: TEAM, serviceUrl: SERVICE_URL, scope: "channel" }) } },
    });
    ok(inChain.surface === teamsReplyChainSurface(CHAN_ON, root), `sibling: the harness's chain surface is the product's reply.post surface (harness ${teamsReplyChainSurface(CHAN_ON, root)}, product ${inChain.surface})`);
    ok(inChain.surface.includes("-messageid-") && inChain.surface !== teamsSegment(CHAN_ON), "sibling: the chain surface is NOT the bare channel id — the exact-equality filter on the channel read nothing (a live run)");
    ok(core.domainKeyOf(inChain).split("/").pop() === teamsSegment(CHAN_ON), "sibling: the domain grain's last segment is the sanitised channel id, the wake.ingress container the gate joins on");
  }

  {
    const { teamsIntroMarkerPartition, teamsIntroClaimKey, resetTeamsIntroMarker } = await import("../packages/core/scripts/e2e/teams-intro-fixture.js");
    const { sqliteProvider } = await import("@open-everywhere/core/agent/memory/sqlite.js");
    const { SURFACE } = await import("@open-everywhere/core/agent/memory/store.js");
    const { ONBOARDED_MARKER } = await import("@open-everywhere/core/agent/onboarding/onboarding.js");
    const store = core.getOperationalStore();
    const reChannel = "19:resetfixture@thread.tacv2";
    const target = teamsFirstContactTarget(message({ channel: reChannel, mentioned: true, text: "hi" }))!;
    const product = teamsIntroPartition(target);
    const harness = teamsIntroMarkerPartition({ org: product.org, tenantId: TENANT, channelId: reChannel });
    ok(
      harness.surfaceKey === product.surfaceKey && harness.workspaceKey === product.workspaceKey && harness.surface === product.surface && harness.workspace === product.workspace,
      `intro reset: the harness keys the marker on the product's own channel partition (harness ${harness.surfaceKey}, product ${product.surfaceKey})`,
    );
    const realDeps = {
      ...deps,
      isOnboarded: async (p: Partition) => (await sqliteProvider.readTier(p, SURFACE))[ONBOARDED_MARKER] !== undefined,
      markOnboarded: async (p: Partition) => void (await sqliteProvider.writeTier(p, SURFACE, { [ONBOARDED_MARKER]: new Date().toISOString(), "keep.md": "x" }, "test")),
      claim: (org: string, key: string, atIso: string) => store.markEventSeen(org, key, atIso, 24 * 60 * 60 * 1000),
    };
    const sentBefore = sent.length;
    ok((await teamsChannelIntro(target, "first-contact", realDeps)).posted === true, "intro reset: the first contact introduces the channel");
    ok((await teamsChannelIntro(target, "first-contact", realDeps)).posted === false, "intro reset: a second contact does not — the channel is introduced (the board's usual state)");
    ok(teamsIntroClaimKey(harness) === `teams-intro:${product.surfaceKey}`, "intro reset: the claim key is the product's spelling");
    const reset = await resetTeamsIntroMarker({ memory: sqliteProvider, store }, harness);
    ok(reset.markerBefore !== undefined && !reset.markerRemains, `intro reset: the reset finds the marker and leaves none (${JSON.stringify(reset)})`);
    ok((await sqliteProvider.readTier(product, SURFACE))["keep.md"] === "x", "intro reset: the reset deletes the marker file alone, never the rest of the tier");
    ok((await teamsChannelIntro(target, "first-contact", realDeps)).posted === true && sent.length === sentBefore + 2, "🔴 intro reset: after the reset the next @mention is a FIRST contact again — the leg measures the door every board");
    const clean = await resetTeamsIntroMarker({ memory: sqliteProvider, store }, teamsIntroMarkerPartition({ org: product.org, tenantId: TENANT, channelId: "19:neverintroduced@thread.tacv2" }));
    ok(clean.markerBefore === undefined && !clean.markerRemains, "intro reset: a channel never introduced resets to the same state");
    const noDelete = await resetTeamsIntroMarker({ memory: { readTier: sqliteProvider.readTier }, store }, harness).then(
      () => "no throw",
      (err: unknown) => String(err),
    );
    ok(noDelete.includes("no per-file delete"), "intro reset: a provider with no per-file delete THROWS — a reset that did not happen never reads as one that did");
  }

  const intros: string[] = [];
  let forwards = 0;
  const handler = buildTeamsFrontHandler(
    async () => {
      forwards++;
      return new Response("native");
    },
    {
      verify: async (req) => req.text(),
      externalGate: async (a) => a.text.includes("gated"),
      markEventSeen: async () => true,
      engagementSeam: async () => ({ kind: "hold", reason: "test", stopped: false }) as never,
      planFor: () => null,
      channelIntro: async (u) => (intros.push(`join:${u.conversationId}`), { posted: true }),
      firstContactIntro: async (a) => (intros.push(`first:${a.conversation.id}`), { posted: true }),
      oeCommand: async () => undefined,
    },
  );
  const post = async (body: unknown) => {
    const waits: Promise<unknown>[] = [];
    await handler(new Request("https://x/eve/v1/teams", { method: "POST", body: JSON.stringify(body) }), { to: {} as never, waitUntil: (p: Promise<unknown>) => waits.push(p) } as never);
    await Promise.all(waits);
  };
  await post(update([BOT]).raw);
  ok(intros.join() === `join:${CHAN_ON}` && forwards === 1, "front: a bot-added update reaches the join door AND still forwards to the native channel");
  await post(update([HUMAN]).raw);
  ok(intros.length === 1 && forwards === 2, "front: an update that adds someone else reaches no door");
  const m = message({ mentioned: true, text: "hello" });
  await post(m.raw);
  ok(intros[1] === `first:${m.conversation.id}`, "front: a channel @mention reaches the first-contact door");
  await post(message({ text: "hello" }).raw);
  ok(intros.length === 2, "front: a plain channel message reaches no intro door");
  await post(message({ mentioned: true, text: "gated hello" }).raw);
  ok(intros.length === 2, "front: an @mention the external-participant gate suppresses reaches NO first-contact intro (the door sits below the gate)");
  await post(message({ mentioned: true, text: "hello", from: "28:another-bot" }).raw);
  ok(intros.length === 2, "front: a machine-authored @mention reaches no first-contact intro");
}

{
  const bindingFor = (scope: Scope, conversationId: string, channelId?: string) =>
    core.bindFrom({
      channel: { kind: "teams" },
      session: { auth: { current: buildTeamsAuth({ userId: HUMAN, tenantId: TENANT, conversationId, ...(channelId ? { channelId, teamId: TEAM } : {}), serviceUrl: SERVICE_URL, scope }) } },
    });
  const personal = bindingFor("personal", PERSONAL_CONV);
  const group = bindingFor("groupChat", GROUP_CONV);
  const channel = bindingFor("channel", `${CHAN_ON};messageid=root-2`, CHAN_ON);
  const personalKey = core.resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: buildTeamsAuth({ userId: HUMAN, tenantId: TENANT, conversationId: PERSONAL_CONV, serviceUrl: SERVICE_URL, scope: "personal" }) } } }).surfaceKey;

  ok(personal.target?.["channelId"] === undefined, "card: precondition — a personal chat's binding carries no target.channelId (routines read that field)");
  const room = teamsOwnCardRoom(personal);
  ok(room?.channelId === PERSONAL_CONV, "card: the personal chat's own card room is its RAW conversation id (what the poster resolves)");
  ok(room?.surfaceKey === personalKey, `card: …keyed on the chat's own partition key, where its DM seat lives (${room?.surfaceKey} vs ${personalKey})`);
  ok(teamsOwnCardRoom(group)?.channelId === GROUP_CONV, "card: a group chat cards into its own conversation too");
  ok(teamsOwnCardRoom(channel) === undefined, "card: a channel answers nothing here — core reads its target.channelId first");

  const venue = approvalVenueFor(personal, core.resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: buildTeamsAuth({ userId: HUMAN, tenantId: TENANT, conversationId: PERSONAL_CONV, serviceUrl: SERVICE_URL, scope: "personal" }) } } }), () => []);
  ok("venue" in venue && venue.venue.sameRoom && venue.venue.channelId === PERSONAL_CONV, `card: the venue walk cards a personal chat IN PLACE, through the registered seam (got ${JSON.stringify(venue)})`);
  const chanVenue = approvalVenueFor(channel, core.resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: buildTeamsAuth({ userId: HUMAN, tenantId: TENANT, conversationId: `${CHAN_ON};messageid=root-2`, channelId: CHAN_ON, teamId: TEAM, serviceUrl: SERVICE_URL, scope: "channel" }) } } }), () => []);
  ok("venue" in chanVenue && chanVenue.venue.channelId === CHAN_ON, "card: a channel still cards into its channel id, unchanged");

  let recorded: RequestApprovalInput | undefined;
  const reply = await runBudgetRaise(personal, 7, {
    effectiveCaps: async () => ({}),
    requestApproval: async (input: RequestApprovalInput) => {
      recorded = input;
      return { id: "pending-chat", expiresAt: "2026-10-13T00:00:00.000Z" } as never;
    },
    friendlyScopeLabel: async () => undefined,
    readSpendCoverage: async () => undefined,
    domains: [],
  });
  ok(recorded?.channelId === PERSONAL_CONV && reply === "" && !reply.includes("pending-chat"), `card: /oe budget raise from a personal chat cards into the chat (got ${recorded?.channelId})`);

  const { wakeWindowOnDecision } = await import("@open-everywhere/core/agent/approvals/flow.js");
  const { dmWindowRegistryKey, supervisorGrainFor } = await import("@open-everywhere/core/agent/channels/unified-supervisor.js");
  const store = core.getOperationalStore();
  const chatAuth = buildTeamsAuth({ userId: HUMAN, tenantId: WIDE_TENANT, conversationId: PERSONAL_CONV, serviceUrl: SERVICE_URL, scope: "personal" });
  const chatBinding = core.bindFrom({ channel: { kind: "teams" }, session: { auth: { current: chatAuth } } });
  const chatKey = core.resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: chatAuth } } }).surfaceKey;
  const grain = supervisorGrainFor(chatKey, [defineDomain({ name: "wide", reach: [`teams/${WIDE_TENANT}`] })]);
  ok(core.grainUsesUnifiedWindow(grain), `fence precondition: the chat key resolves a domain window under the tenant-wide claim (${grain.registryKey})`);
  await store.rotateChannelSession(chatBinding.org, grain.registryKey, "oe-dom:wide:oe-sup:g1-domainwin", new Date().toISOString());
  const origin = { platform: "teams" as const, serviceUrl: SERVICE_URL, conversationId: PERSONAL_CONV, tenantId: WIDE_TENANT };
  const seedAuthority = (id: string, mode: string) =>
    store.putTaskResult(
      chatBinding.org,
      `approval-decision-authority:${id}`,
      JSON.stringify({ binding: { ...chatBinding, mode }, origin, surfaceKey: chatKey, requester: { kind: "requester", principalId: HUMAN }, nonMemberWake: false }),
      new Date().toISOString(),
      24 * 3600 * 1000,
    );
  const decisionRow = (id: string) => ({ id, org: chatBinding.org, kind: "spend.set", argsJson: "{}", channelId: PERSONAL_CONV, postedTo: chatKey, scopeKey: chatKey, status: "approved" }) as never;
  const woken: string[] = [];
  const decide = (id: string) =>
    wakeWindowOnDecision({ row: decisionRow(id), outcome: "approved", summaryLine: "cap", surfaceKey: chatKey, origin }, { dispatch: async (w: { token: string }) => (woken.push(w.token), true) } as never);

  await seedAuthority("chat-as-channel", "channel");
  ok((await decide("chat-as-channel")) === true && woken.join() === "oe-dom:wide:oe-sup:g1-domainwin", "fence (negative control): a channel authority on this key wakes the domain window");
  woken.length = 0;
  await seedAuthority("chat-no-seat", "dm");
  ok((await decide("chat-no-seat")) === false && woken.length === 0, "🔴 fence: a CHAT card with no DM seat wakes NOTHING — never the tenant-wide domain window");
  const DM_TOKEN = `oe-dom:oe-dm/${chatKey}:oe-sup:g1-c4a75ea7`;
  await store.rotateChannelSession(chatBinding.org, dmWindowRegistryKey(chatKey), DM_TOKEN, new Date().toISOString());
  await seedAuthority("chat-with-seat", "dm");
  ok((await decide("chat-with-seat")) === true && woken.join() === DM_TOKEN, `fence: a CHAT card's decision wakes the chat's own DM seat (got ${woken.join()})`);

  ok(
    typeof TEAMS_SURFACE_PARITY["approval-card"] === "object" && "supported" in TEAMS_SURFACE_PARITY["approval-card"] && /personal chat/.test(TEAMS_SURFACE_PARITY["approval-card"].supported),
    "parity: the approval-card cell says a personal chat hosts its own card",
  );
}

console.log(`✓ teams-parity: ${passed} assertions passed`);
