import assert from "node:assert/strict";
import { parseTeamsActivity, isTeamsInputResponseActivity, TEAMS_HITL_DATA_KEY, type TeamsMessageActivity } from "eve/channels/teams";
import { bindTeams, buildTeamsAuth } from "../agent/channels/teams-identity.js";
import { buildTeamsFrontHandler } from "../agent/channels/teams-front.js";
import type { TeamsFrontPlan } from "../agent/channels/teams-front.js";
import {
  markTeamsEngaged,
  noteTeamsSeamArmed,
  noteTeamsSeamDelivery,
  resetTeamsSeamSupport,
  resolveTeamsEngagement,
  teamsEngagedAdmits,
  teamsEngagementAnchor,
  teamsMachineAuthored,
  teamsSeamDeliveryProven,
  teamsSeamGrant,
  teamsRoomWatchStopped,
  teamsSeamUnsupportedReason,
  type TeamsEngagementDeps,
  type TeamsEngagementVerdict,
} from "../agent/channels/teams-engagement.js";
import { resolvePartition, type BindableContext, type EngagementRow, type Partition } from "@open-everywhere/core/agent/adapter-api.js";

import { rmSync as __rmSuiteStore } from "node:fs";
import { join as __joinSuiteStore } from "node:path";
import { tmpdir as __tmpdirSuiteStore } from "node:os";
const __suiteStoreDir = __joinSuiteStore(__tmpdirSuiteStore(), `open-everywhere-suite-teams-engagement-${process.pid}`);
__rmSuiteStore(__suiteStoreDir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = __joinSuiteStore(__suiteStoreDir, "ops.sqlite3");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const BOT = "28:bot-app-id";
const HUMAN = "29:human-1";
const TENANT = "TENANT_E";
const CHANNEL_CONV = "19:channel-chain@thread.tacv2";
const GROUP_CONV = "19:group-chat@thread.v2";
const PERSONAL_CONV = "19:1on1@thread.v2";
const SERVICE_URL = "https://smba.trafficmanager.net/uk/";

type Scope = "channel" | "groupChat" | "personal";

function conversationIdFor(scope: Scope): string {
  return scope === "channel" ? CHANNEL_CONV : scope === "groupChat" ? GROUP_CONV : PERSONAL_CONV;
}

function activityBody(scope: Scope, opts: { mentioned?: boolean; id?: string; text?: string } = {}): string {
  const body: Record<string, unknown> = {
    type: "message",
    channelId: "msteams",
    id: opts.id ?? `act-${scope}-${opts.mentioned ? "mention" : "plain"}`,
    serviceUrl: SERVICE_URL,
    from: { id: HUMAN, name: "Hazel" },
    recipient: { id: BOT, name: "Test Agent" },
    conversation: { id: conversationIdFor(scope), conversationType: scope, tenantId: TENANT },
    text: opts.text ?? "hello there",
  };
  if (scope === "channel") body.channelData = { channel: { id: "19:team-chan" }, team: { id: "TEAM_E" } };
  if (opts.mentioned) body.entities = [{ type: "mention", text: "<at>Test Agent</at>", mentioned: { id: BOT, name: "Test Agent" } }];
  return JSON.stringify(body);
}

function activity(scope: Scope, opts: { mentioned?: boolean; id?: string; text?: string } = {}): TeamsMessageActivity {
  const parsed = parseTeamsActivity(JSON.parse(activityBody(scope, opts)));
  assert.ok(parsed && parsed.type === "message", "fixture must parse as a message activity");
  return parsed;
}

function row(over: Partial<EngagementRow> = {}): EngagementRow {
  return {
    org: "default",
    surfaceKey: `teams/${TENANT}/x`,
    threadTs: CHANNEL_CONV,
    engagedAt: "2026-09-07T00:00:00Z",
    lastTurnAt: "2026-09-07T00:00:00Z",
    participating: true,
    silentStreak: 0,
    kind: "thread",
    stopped: false,
    ...over,
  };
}

function depsFor(rows: Record<string, EngagementRow | null>): {
  deps: TeamsEngagementDeps;
  marks: { key: string; partition: Partition }[];
} {
  const marks: { key: string; partition: Partition }[] = [];
  return {
    marks,
    deps: {
      getEngagement: async (_p, key) => rows[key] ?? null,
      markEngaged: async (p, key) => {
        marks.push({ key, partition: p });
      },
      now: () => "2026-09-07T12:00:00Z",
    },
  };
}

{
  const ctxFor = (scope: Scope): BindableContext =>
    ({
      channel: { kind: "teams" },
      session: {
        auth: {
          current: buildTeamsAuth({
            userId: HUMAN,
            tenantId: TENANT,
            conversationId: conversationIdFor(scope),
            channelId: scope === "channel" ? "19:team-chan" : undefined,
            teamId: scope === "channel" ? "TEAM_E" : undefined,
            serviceUrl: SERVICE_URL,
            scope,
          }),
        },
      },
    }) as unknown as BindableContext;

  ok(bindTeams(ctxFor("channel")).engagementKey === CHANNEL_CONV, "1a: a CHANNEL turn publishes engagementKey = the conversation id (the reply chain) — the row stand_down marks");
  ok(bindTeams(ctxFor("groupChat")).engagementKey === GROUP_CONV, "1b: a GROUP CHAT turn publishes engagementKey = the chat id");
  ok(bindTeams(ctxFor("personal")).engagementKey === undefined, "1c: NEGATIVE CONTROL — a 1:1 chat publishes NO anchor (it is answered unconditionally, so a mark would suppress nothing)");
  ok(teamsEngagementAnchor("channel", CHANNEL_CONV) === bindTeams(ctxFor("channel")).engagementKey, "1d: the seam's anchor predicate and the mapper agree (channel)");
  ok(teamsEngagementAnchor("groupChat", GROUP_CONV) === bindTeams(ctxFor("groupChat")).engagementKey, "1d: …and on a group chat");
  ok(teamsEngagementAnchor("personal", PERSONAL_CONV) === undefined, "1d: …and on a 1:1, where both say there is none");
  ok(teamsEngagementAnchor("channel", "") === undefined, "1e: an empty conversation id yields no anchor — never a row keyed on nothing");
}

{
  const engaged = depsFor({ [CHANNEL_CONV]: row() });
  const unengaged = depsFor({});
  const stopped = depsFor({ [CHANNEL_CONV]: row({ stopped: true }) });

  const mention = await resolveTeamsEngagement(activity("channel", { mentioned: true }), false, unengaged.deps);
  ok(mention.kind === "engage" && mention.anchor === CHANNEL_CONV, "2a: an @mention resolves ENGAGE on the conversation anchor");
  ok(mention.kind === "engage" && mention.org.length > 0, "2a2: …carrying the row's org, which is what lets the front DEDUPE the mark (a redelivered mention must not clear a stand-down)");
  ok(unengaged.marks.length === 0, "2b: …and resolving is READ-ONLY — the verdict never writes the row (the mark is its own call)");

  const deliver = await resolveTeamsEngagement(activity("channel"), false, engaged.deps);
  ok(deliver.kind === "deliver", "2c: a PLAIN message in an ENGAGED conversation resolves DELIVER — the wake this ticket adds");
  ok(deliver.kind === "deliver" && deliver.threadEngaged === true, "2c2: 🔴 OPE-2610 — …and the verdict says the row is an ENROLMENT, the fact Leg A's wake states");
  const warm = await resolveTeamsEngagement(activity("channel"), false, depsFor({ [CHANNEL_CONV]: row({ participating: false }) }).deps);
  ok(
    warm.kind === "deliver" && warm.threadEngaged === false,
    "2c3: 🔴 NEGATIVE CONTROL — a WARM row (participating: false) still delivers, but it is no enrolment, so the verdict says so",
  );

  const hold = await resolveTeamsEngagement(activity("channel"), false, unengaged.deps);
  ok(hold.kind === "hold" && hold.stopped === false, "2d: NEGATIVE CONTROL — the same plain message in an UN-engaged conversation HOLDS, and not because of a stop");

  const stop = await resolveTeamsEngagement(activity("channel"), false, stopped.deps);
  ok(stop.kind === "hold" && stop.stopped === true, "2e: a STOOD-DOWN conversation holds AND says so — the flag the front reads to suppress both legs");

  const botAuthored = await resolveTeamsEngagement(activity("channel"), true, engaged.deps);
  ok(botAuthored.kind === "hold", "2f: a machine-authored plain message never delivers, even in an engaged conversation (no self-trigger loop)");

  const personal = await resolveTeamsEngagement(activity("personal"), false, engaged.deps);
  ok(personal.kind === "unanchored", "2g: a 1:1 chat is UNANCHORED — the seam has nothing to say, and the DM divert answers it unconditionally");

  const groupDeliver = await resolveTeamsEngagement(activity("groupChat"), false, depsFor({ [GROUP_CONV]: row() }).deps);
  ok(groupDeliver.kind === "deliver", "2h: a group chat engages and delivers on the same terms — the chat id is its anchor");

  const marking = depsFor({});
  const anchor = await markTeamsEngaged(activity("channel", { mentioned: true }), marking.deps);
  ok(anchor === CHANNEL_CONV && marking.marks.length === 1, "2i: markTeamsEngaged writes exactly one row, on the conversation anchor");
  const standDownPartition = resolvePartition({
    channel: { kind: "teams" },
    session: {
      auth: {
        current: buildTeamsAuth({ userId: HUMAN, tenantId: TENANT, conversationId: CHANNEL_CONV, channelId: "19:team-chan", teamId: "TEAM_E", serviceUrl: SERVICE_URL, scope: "channel" }),
      },
    },
  } as unknown as BindableContext);
  ok(marking.marks[0].partition.surfaceKey === standDownPartition.surfaceKey, "2j: …in the CONVERSATION-grain partition stand_down itself resolves, not the widened channel grain");
  ok((await markTeamsEngaged(activity("personal", { mentioned: true }), marking.deps)) === null && marking.marks.length === 1, "2k: NEGATIVE CONTROL — a 1:1 mention marks nothing at all");
}

{
  interface FrontRun {
    readonly forward: number;
    readonly dispatch: number;
    readonly dm: number;
    readonly marks: number;
    readonly roomWatched: number;
    readonly roomCleared: number;
    readonly dispatchedEngaged: readonly (boolean | undefined)[];
  }

  async function run(
    body: string,
    verdict: TeamsEngagementVerdict,
    opts: { plan?: boolean; addressing?: string; roomStopped?: boolean } = {},
  ): Promise<FrontRun> {
    let forward = 0;
    let dispatch = 0;
    let dm = 0;
    let marks = 0;
    let roomWatched = 0;
    let roomCleared = 0;
    const dispatchedEngaged: (boolean | undefined)[] = [];
    const waits: Promise<unknown>[] = [];
    const handler = buildTeamsFrontHandler(
      async () => {
        forward++;
        return new Response("native");
      },
      {
        verify: async () => body,
        markEventSeen: async () => true,
        externalGate: async () => false,
        engagementSeam: async () => verdict,
        markEngaged: async () => {
          marks++;
          return CHANNEL_CONV;
        },
        roomStopped: async () => opts.roomStopped === true,
        markRoomWatched: async () => {
          roomWatched++;
        },
        clearRoomStop: async () => {
          roomCleared++;
        },
        planFor: (): TeamsFrontPlan | null =>
          opts.plan
            ? ({
                window: { wakeId: "wk-1", addressing: opts.addressing, origin: { platform: "teams", serviceUrl: SERVICE_URL, conversationId: CHANNEL_CONV } },
                surfaceKey: `teams/${TENANT}/chan`,
                partition: { org: "default", platform: "teams", workspace: TENANT, surfaceKey: `teams/${TENANT}/chan` } as unknown as Partition,
                grain: {} as never,
                auth: {} as never,
              } as unknown as TeamsFrontPlan)
            : null,
        dispatch: async (_a, plan) => {
          dispatch++;
          dispatchedEngaged.push(plan.threadEngaged);
        },
        dmDivert: async () => {
          dm++;
        },
      },
    );
    const args = { to: {} as never, waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as Parameters<typeof handler>[1];
    await handler(new Request("https://oe.test/eve/v1/teams", { method: "POST", body }), args);
    await Promise.all(waits);
    return { forward, dispatch, dm, marks, roomWatched, roomCleared, dispatchedEngaged };
  }

  const engage: TeamsEngagementVerdict = { kind: "engage", anchor: CHANNEL_CONV, org: "default" };
  const deliver: TeamsEngagementVerdict = { kind: "deliver", anchor: CHANNEL_CONV, reason: "engaged thread, human reply — deliver to the live session", threadEngaged: true };
  const deliverWarm: TeamsEngagementVerdict = { ...deliver, threadEngaged: false };
  const holdOpen: TeamsEngagementVerdict = { kind: "hold", anchor: CHANNEL_CONV, reason: "thread is not engaged", stopped: false };
  const holdStopped: TeamsEngagementVerdict = { kind: "hold", anchor: CHANNEL_CONV, reason: "asked to stand down in this thread", stopped: true };
  const unanchored: TeamsEngagementVerdict = { kind: "unanchored", reason: "a 1:1 chat carries no engagement anchor" };

  const mentionNative = await run(activityBody("channel", { mentioned: true }), engage);
  ok(mentionNative.marks === 1 && mentionNative.forward === 1 && mentionNative.dispatch === 0, "3a: NATIVE path — a mention marks the row once and still forwards to the native channel (its own mention gate answers)");
  const mentionWindow = await run(activityBody("channel", { mentioned: true }), engage, { plan: true });
  ok(mentionWindow.marks === 1 && mentionWindow.dispatch === 1 && mentionWindow.forward === 0, "3b: SINGLE-WINDOW path — the same mention marks the row AND Leg A dispatches it; the mark is what makes stand_down work here");

  const deliverNative = await run(activityBody("channel"), deliver);
  ok(deliverNative.forward === 1 && deliverNative.dispatch === 0, "3c: a DELIVER verdict on the native path forwards exactly once (the native gate then admits it) and Leg A dispatches nothing");
  const deliverWindow = await run(activityBody("channel"), deliver, { plan: true });
  ok(deliverWindow.dispatch === 1 && deliverWindow.forward === 0, "3d: on a single-window surface Leg A alone handles it — ONE dispatch, ZERO forwards: the two legs never both handle one message");
  ok(
    deliverWindow.dispatchedEngaged[0] === true,
    "3d2: 🔴 OPE-2610 — Leg A's dispatch CARRIES the seam's enrolment verdict, so the seat's wake can say the chain is engaged",
  );
  const warmWindow = await run(activityBody("channel"), deliverWarm, { plan: true });
  ok(warmWindow.dispatch === 1 && warmWindow.dispatchedEngaged[0] === undefined, "3d3: NEGATIVE CONTROL — a WARM row's delivery carries no enrolment");
  const ambientWindow = await run(activityBody("channel"), holdOpen, { plan: true });
  ok(ambientWindow.dispatch === 1 && ambientWindow.dispatchedEngaged[0] === undefined, "3d4: NEGATIVE CONTROL — an un-engaged ambient message carries no enrolment");

  const stoppedNative = await run(activityBody("channel"), holdStopped);
  ok(stoppedNative.forward === 0 && stoppedNative.dispatch === 0, "3e: 🔴 a STOOD-DOWN conversation suppresses the message ABOVE the forward — the one case the front stops rather than letting the native gate answer");
  const stoppedWindow = await run(activityBody("channel"), holdStopped, { plan: true });
  ok(stoppedWindow.dispatch === 0 && stoppedWindow.forward === 0, "3f: 🔴 …and on LEG A too — the ambient wake that read no registry is now suppressed by the stop");
  ok(stoppedWindow.marks === 0, "3g: …and a suppressed message marks nothing (only a mention re-engages)");

  const openNative = await run(activityBody("channel"), holdOpen);
  ok(openNative.forward === 1 && openNative.dispatch === 0, "3h: an UN-engaged plain message still FORWARDS on the native path, byte-identically to before this leg — its own mention gate is what drops it");
  const openWindow = await run(activityBody("channel"), holdOpen, { plan: true });
  ok(openWindow.dispatch === 1, "3i: 🔴 NEGATIVE CONTROL — the same un-engaged message STILL reaches Leg A on a vouched single-window surface; the seam did not narrow the domain's opted-in ambient posture");

  {
    const ambient = await run(activityBody("channel"), holdOpen, { plan: true });
    ok(
      ambient.dispatch === 1 && ambient.roomWatched === 1,
      "3o: 🔴 an AMBIENT Leg A wake stores a room-grain watch row — the stored wake a stored stop needs, and without it stand_down has nothing to mark",
    );
    const ambientStopped = await run(activityBody("channel"), holdOpen, { plan: true, roomStopped: true });
    ok(
      ambientStopped.dispatch === 0 && ambientStopped.forward === 0,
      "3p: 🔴 …and once that room row carries the stop, the undirected wake is SUPPRESSED — the gap a person in the room could not close by any verb",
    );
    ok(
      ambientStopped.roomWatched === 0,
      "3q: …a suppressed wake refreshes nothing either, so a stopped room cannot re-arm itself",
    );

    const mentionOnStoppedRoom = await run(activityBody("channel", { mentioned: true }), engage, {
      plan: true,
      addressing: "direct-mention",
      roomStopped: true,
    });
    ok(
      mentionOnStoppedRoom.roomCleared === 1 && mentionOnStoppedRoom.dispatch === 1,
      "3r: 🔴 an @MENTION lifts the ROOM stop and is answered — the room stop is reversible, and by the same act that reverses a conversation stop",
    );
    ok(
      mentionOnStoppedRoom.roomWatched === 0,
      "3r2: …and an addressed wake writes no watch row: it re-invited the room a line earlier, so a watch write would be a second spelling of the same fact",
    );

    const ambientOpen = await run(activityBody("channel"), holdOpen, { plan: true, roomStopped: false });
    ok(
      ambientOpen.dispatch === 1,
      "3s0: 🔴 NEGATIVE CONTROL — with the room NOT stopped the same ambient wake dispatches, so 3p measured the flag and not the topology",
    );

    const rawHitl = JSON.parse(activityBody("channel")) as Record<string, unknown>;
    rawHitl.value = { [TEAMS_HITL_DATA_KEY]: { requestId: "req-room-1" } };
    const parsedRoomHitl = parseTeamsActivity(rawHitl);
    assert.ok(parsedRoomHitl && parsedRoomHitl.type === "message", "room HITL fixture must parse as a message activity");
    ok(isTeamsInputResponseActivity(parsedRoomHitl), "3s1: precondition — eve reads this channel fixture as an input-response activity");
    const roomHitl = await run(JSON.stringify(rawHitl), holdOpen, { plan: true, roomStopped: true });
    ok(
      roomHitl.forward === 1 && roomHitl.dispatch === 0,
      "3s2: 🔴 a STOOD-DOWN room still FORWARDS an answer to a parked question — standing down means stop following the room, never stop listening to what the agent asked",
    );

    const nativeWithRoomStop = await run(activityBody("channel"), holdOpen, { roomStopped: true });
    ok(
      nativeWithRoomStop.forward === 1 && nativeWithRoomStop.roomWatched === 0,
      "3s3: 🔴 the room gate is Leg A's ALONE — an off-window activity still forwards to the native path, and stores no room row",
    );
  }

  const personal = await run(activityBody("personal"), unanchored);
  ok(personal.dm === 1, "3j: a 1:1 chat still diverts to its own DM window unconditionally — 'a DM is always answered' is unchanged");
  const groupEngaged = await run(activityBody("groupChat"), deliver);
  ok(groupEngaged.dm === 1, "3k: an ENGAGED group chat wakes on a plain message");
  const groupOpen = await run(activityBody("groupChat"), holdOpen);
  ok(groupOpen.dm === 0 && groupOpen.forward === 0, "3l: 🔴 an UN-engaged group chat does NOT — before this, the ChatMessage.Read.Chat grant ran a full session on every message any member typed");
  const groupStopped = await run(activityBody("groupChat"), holdStopped);
  ok(groupStopped.dm === 0, "3m: …and a stood-down group chat stays quiet too");
  {
    const raw = JSON.parse(activityBody("groupChat")) as Record<string, unknown>;
    raw.value = { [TEAMS_HITL_DATA_KEY]: { requestId: "req-group-1" } };
    const parsedGroupHitl = parseTeamsActivity(raw);
    assert.ok(parsedGroupHitl && parsedGroupHitl.type === "message", "group HITL fixture must parse as a message activity");
    ok(isTeamsInputResponseActivity(parsedGroupHitl), "3m2: precondition — eve reads this group-chat fixture as an input-response activity");
    const groupHitlOpen = await run(JSON.stringify(raw), holdOpen);
    ok(groupHitlOpen.forward === 1 && groupHitlOpen.dm === 0, "3m3: 🔴 an UN-ENGAGED group chat still FORWARDS an answer to a parked question — the seam gates the room, never a question the agent itself asked");
    const groupHitlStopped = await run(JSON.stringify(raw), holdStopped);
    ok(groupHitlStopped.forward === 1, "3m4: …and a STOOD-DOWN group chat forwards it too (the hold's cause never changes this answer)");
  }
  const groupMention = await run(activityBody("groupChat", { mentioned: true }), { ...engage, anchor: GROUP_CONV });
  ok(groupMention.dm === 1 && groupMention.marks === 1, "3n: 🔴 an @MENTION in a group chat marks the chat AND wakes it — the way a group chat becomes engaged in the first place");

  {
    let marks = 0;
    let dispatch = 0;
    const waits: Promise<unknown>[] = [];
    const seen = new Set<string>();
    const body = activityBody("channel", { mentioned: true, id: "act-replay" });
    const handler = buildTeamsFrontHandler(async () => new Response("native"), {
      verify: async () => body,
      externalGate: async () => false,
      engagementSeam: async () => engage,
      markEngaged: async () => {
        marks++;
        return CHANNEL_CONV;
      },
      markEventSeen: async (_org, key) => (seen.has(key) ? false : (seen.add(key), true)),
      planFor: () => null,
      dispatch: async () => {
        dispatch++;
      },
    });
    const args = { to: {} as never, waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as Parameters<typeof handler>[1];
    const req = () => new Request("https://oe.test/eve/v1/teams", { method: "POST", body });
    await handler(req(), args);
    ok(marks === 1, "3o: the first delivery of a mention marks the conversation once");
    await handler(req(), args);
    await Promise.all(waits);
    ok(marks === 1, "3p: 🔴 a REDELIVERY of the SAME mention marks NOTHING — the mark re-invites, which clears a stop, so a replay must not lift a stand-down");
    ok(dispatch === 0, "3q: …and neither delivery dispatched here (this fixture has no plan) — the dedupe under test is the MARK's own, not the wake's");
  }

  {
    const raw = JSON.parse(activityBody("channel")) as Record<string, unknown>;
    raw.value = { [TEAMS_HITL_DATA_KEY]: { requestId: "req-1" } };
    const hitlBody = JSON.stringify(raw);
    const parsedHitl = parseTeamsActivity(raw);
    assert.ok(parsedHitl && parsedHitl.type === "message", "HITL fixture must parse as a message activity");
    ok(isTeamsInputResponseActivity(parsedHitl), "3r: precondition — eve reads this fixture as an input-response activity, not an ordinary message");
    const stoppedHitl = await run(hitlBody, holdStopped);
    ok(stoppedHitl.forward === 1, "3s: 🔴 …so a stood-down conversation still FORWARDS it — standing down means stop following the room, never stop listening to what the agent asked");
    const stoppedPlain = await run(activityBody("channel"), holdStopped);
    ok(stoppedPlain.forward === 0, "3t: ⭐ NEGATIVE CONTROL: an ordinary plain message in the SAME stood-down state is still suppressed");
  }
}

{
  const engaged = depsFor({ [CHANNEL_CONV]: row() });
  const unengaged = depsFor({});
  const stopped = depsFor({ [CHANNEL_CONV]: row({ stopped: true }) });

  ok((await teamsEngagedAdmits(activity("channel"), engaged.deps)) === true, "4a: the native gate ADMITS a plain message in an engaged conversation — this is what turns it into a turn");
  ok((await teamsEngagedAdmits(activity("channel"), unengaged.deps)) === false, "4b: NEGATIVE CONTROL — it refuses the same message in an un-engaged conversation");
  ok((await teamsEngagedAdmits(activity("channel"), stopped.deps)) === false, "4c: …and refuses a stood-down conversation");
  ok((await teamsEngagedAdmits(activity("channel", { mentioned: true }), unengaged.deps)) === true, "4d: a mention is admitted without consulting the registry (the caller's own gate already passed it)");
  ok(engaged.marks.length === 0 && unengaged.marks.length === 0 && stopped.marks.length === 0, "4e: 🔴 the native admission NEVER writes — the mark has exactly one writer, the front");

  const machineShapes: { readonly label: string; readonly over: Record<string, unknown> }[] = [
    { label: "the agent's own id (from === recipient)", over: { from: { id: BOT, name: "Test Agent" } } },
    { label: 'an explicit `role: "bot"` author', over: { from: { id: HUMAN, name: "Hazel", role: "bot" } } },
    { label: "any `28:` application id", over: { from: { id: "28:another-app", name: "Some App" } } },
  ];
  for (const shape of machineShapes) {
    const raw = JSON.parse(activityBody("channel")) as Record<string, unknown>;
    Object.assign(raw, shape.over);
    const parsed = parseTeamsActivity(raw);
    assert.ok(parsed && parsed.type === "message", "machine-shape fixture must parse");
    ok(teamsMachineAuthored(parsed) === true, `4f: teamsMachineAuthored recognises ${shape.label}`);
    ok((await teamsEngagedAdmits(parsed, depsFor({ [CHANNEL_CONV]: row() }).deps)) === false, `4g: 🔴 …so the native gate REFUSES it even in an ENGAGED conversation — ${shape.label}`);
  }
  ok(teamsMachineAuthored(activity("channel")) === false, "4h: ⭐ NEGATIVE CONTROL: an ordinary human author is NOT machine-authored, so the three refusals above are about the author and not about the gate");
}

{
  resetTeamsSeamSupport();
  ok(teamsSeamGrant("channel") === "ChannelMessage.Read.Group", "5a: a team channel names ChannelMessage.Read.Group");
  ok(teamsSeamGrant("groupChat") === "ChatMessage.Read.Chat", "5b: a group chat names ChatMessage.Read.Chat");
  ok(teamsSeamGrant("personal") === undefined, "5c: a 1:1 needs no grant — its messages are delivered unconditionally");
  ok(teamsSeamUnsupportedReason("channel").includes("ChannelMessage.Read.Group"), "5d: the unsupported reason NAMES the grant, so a log line or a doc row can carry it verbatim");

  ok(noteTeamsSeamArmed("channel") === true, "5e: arming an unproven scope declares the seam unsupported — never a silent gap");
  ok(noteTeamsSeamArmed("channel") === false, "5f: …ONCE per scope, not once per mention");
  ok(noteTeamsSeamArmed("groupChat") === true, "5g: …and each scope declares its own grant");
  ok(noteTeamsSeamArmed("personal") === false, "5h: NEGATIVE CONTROL — a 1:1 never declares anything (it depends on no grant)");

  resetTeamsSeamSupport();
  ok(teamsSeamDeliveryProven("channel") === false, "5i: nothing is proven before a non-mention message arrives");
  noteTeamsSeamDelivery("channel");
  ok(teamsSeamDeliveryProven("channel") === true, "5j: a delivered non-mention message PROVES the grant present — Microsoft would not have sent it otherwise");
  ok(noteTeamsSeamArmed("channel") === false, "5k: …so the unsupported declaration stops for that scope");
  ok(teamsSeamDeliveryProven("groupChat") === false, "5l: NEGATIVE CONTROL — proving one scope proves nothing about the other (they are separate grants)");

  resetTeamsSeamSupport();
  await resolveTeamsEngagement(activity("channel"), false, depsFor({}).deps);
  ok(teamsSeamDeliveryProven("channel") === true, "5m: resolving a PLAIN message records the proof — even one the seam then holds");
  resetTeamsSeamSupport();
  await resolveTeamsEngagement(activity("channel", { mentioned: true }), false, depsFor({}).deps);
  ok(teamsSeamDeliveryProven("channel") === false, "5n: 🔴 NEGATIVE CONTROL — a MENTION proves nothing; mentions are delivered with or without the grant, which is the whole reason the gap is invisible");
}

{
  const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import(
    "@open-everywhere/core/agent/adapter-api.js"
  );
  const live = getOperationalStore();
  const part = resolvePartition({
    channel: { kind: "teams" as const },
    session: {
      auth: {
        current: buildTeamsAuth({
          userId: HUMAN,
          tenantId: TENANT,
          conversationId: CHANNEL_CONV,
          channelId: "19:room-fc@thread.tacv2",
          scope: "channel",
        }) as unknown as { attributes?: Readonly<Record<string, string>> },
      },
    },
  } as never);

  ok((await teamsRoomWatchStopped(part)) === false, "4a: precondition — with a readable store and no row, the room is NOT stopped and the wake proceeds");

  const broken = { ...live, getEngagement: async () => { throw new Error("store down"); } } as typeof live;
  registerOperationalStore(broken);
  resetOperationalStore();
  ok(
    (await teamsRoomWatchStopped(part)) === true,
    "🔴 4b: an UNREADABLE store HOLDS the ambient wake — fail-CLOSED, because a wake gate cannot prove the agent is still welcome, and the same outage blocks re-asserting the stop",
  );
  registerOperationalStore(live);
  resetOperationalStore();
  ok((await teamsRoomWatchStopped(part)) === false, "🔴 4c: NEGATIVE CONTROL — with the live store back it answers false again, so 4b measured the failure and not a latched flag");
}

console.log(`✓ teams-engagement: ${passed} assertions passed`);
