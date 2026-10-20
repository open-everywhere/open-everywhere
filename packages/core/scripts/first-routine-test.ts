import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-first-routine-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_MEMORY_DIR = join(tmp, "memory");
delete process.env.DATABASE_URL;

const { overrideSettingsForTest } = await import("../agent/settings/settings.js");
const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");
_setDeploymentIdentityForTest({ org: "default" });
overrideSettingsForTest({ delegation: { oneshotAgent: false } });
overrideSettingsForTest({ window: { topology: false } });

const { registerSlackTestBridge, registerSlackFixtureMapper, registerSlackFixtureCodec } = await import("./_slack-test-stubs.js");
registerSlackTestBridge();
registerSlackFixtureMapper();
registerSlackFixtureCodec();
const { registerConfig } = await import("../agent/access/config.js");
registerConfig({ loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [] });

const fr = await import("../agent/onboarding/first-routine.js");
const { markSurfaceOnboarded, ONBOARDED_MARKER } = await import("../agent/onboarding/onboarding.js");
const state = await import("../agent/personal-watch/state.js");
const { enrollFromBinding } = await import("../agent/hooks/personal-watch-enroll.js");
const { getProvider } = await import("../agent/memory/provider.js");
const { SURFACE } = await import("../agent/memory/store.js");
const { partitionOfBinding } = await import("../agent/memory/partition.js");
const { renderScopeMarkdown } = await import("../agent/instructions/access.js");
await import("../agent/approvals/flow.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { FIRST_ROUTINE_CASES, scoreFirstRoutineTurn } = await import("./eval/first-routine-offline.js");
type SurfaceBinding = import("../agent/identity/binding.js").SurfaceBinding;
type RoutineCreateArgs = import("../agent/approvals/routine-create.js").RoutineCreateArgs;

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    removeTempDir(tmp);
    process.exit(1);
  }
  n++;
}

const ORG = "default";
const DAY = 86_400_000;
const T0 = "2026-10-14T09:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();
const dmOf = (person: string, dm: string): SurfaceBinding =>
  ({ org: ORG, platform: "slack", workspace: "T1", surface: dm, mode: "dm", visibility: "private", trust: "internal", principalId: person }) as SurfaceBinding;
const roomOf = (person: string, room: string): SurfaceBinding =>
  ({ org: ORG, platform: "slack", workspace: "T1", surface: room, mode: "channel", visibility: "public", trust: "internal", principalId: person }) as SurfaceBinding;
const block = (b: SurfaceBinding, nowIso: string, worker = false) => fr.firstConversationBlock({ binding: b, partition: partitionOfBinding(b), worker, nowIso });
const routineArgs = (b: SurfaceBinding, person: string): RoutineCreateArgs => {
  const partition = partitionOfBinding(b);
  return {
    org: ORG,
    partition,
    surfaceKey: partition.surfaceKey,
    target: { channelId: b.surface },
    trigger: { kind: "cron", expr: "0 9 * * 1" } as RoutineCreateArgs["trigger"],
    prompt: "List the open support tickets and post a short digest.",
    createdBy: person,
    ...(b.mode === "channel" ? { firstRoutineRoom: true as const } : {}),
  };
};

console.log("§1 the window and the marker");
{
  ok(fr.firstConversationDays() === 3, "the window ships at 3 days");
  ok(fr.firstConversationOpen({ since: T0 }, at(DAY), 3), "an offer stamped a day ago is open");
  ok(!fr.firstConversationOpen({ since: T0 }, at(3 * DAY), 3), "🔴 the window closes after the configured days");
  ok(!fr.firstConversationOpen({ since: T0 }, at(-1000), 3), "a stamp in the future is not open");
  ok(!fr.firstConversationOpen({ since: T0, outcome: "declined" }, at(1000), 3), "🔴 a declined offer is closed");
  ok(!fr.firstConversationOpen({ since: T0 }, at(1000), 0), "`0` days turns the offer off");
  ok(!fr.firstConversationOpen({ since: "not a date" }, at(1000), 3), "a broken stamp is not open");
  ok(fr.parseRoomFirstRoutine(fr.roomFirstRoutineMarker(T0))?.since === T0, "the room marker round-trips");
  ok(fr.parseRoomFirstRoutine(JSON.stringify({ since: T0, outcome: "garbled" }))?.outcome === "declined", "an outcome that does not parse reads as declined");
  ok(fr.parseRoomFirstRoutine("{") === undefined && fr.parseRoomFirstRoutine(undefined) === undefined, "a broken or missing marker reads as none");
  for (const b of [fr.DM_FIRST_CONVERSATION_BLOCK, fr.ROOM_FIRST_CONVERSATION_BLOCK]) {
    ok(/ONE routine/u.test(b) && /only once/u.test(b) && /do not offer a routine again/u.test(b), "the block says one offer, once, and never again after a no");
    ok(/hand off the job that creates that routine/u.test(b) && /one confirmation/u.test(b), "the block makes the card the one confirmation");
    ok(/never an\s+id/u.test(b) && /offer nothing/u.test(b), "the block forbids ids and allows no offer at all");
  }
}

console.log("§2 the first DM turn stamps the first conversation");
{
  ok((await enrollFromBinding(dmOf("UANA", "DANA"))) === "enrolled", "Ana's first DM turn enrols her");
  const ana = (await state.readPersonalWatch(ORG, "slack/T1/UANA")).state;
  ok(ana?.firstConversation?.surfaceKey === "slack/T1/DANA" && ana.firstConversation.outcome === undefined, "🔴 …and stamps her first conversation in her own DM");
  ok((await state.enrollPersonalWatch(ORG, "slack/T1/UBEN")) === "enrolled", "Ben was enrolled from the Home tab");
  ok((await enrollFromBinding(dmOf("UBEN", "DBEN"))) === "already", "Ben's later DM turn finds his row");
  ok((await state.readPersonalWatch(ORG, "slack/T1/UBEN")).state?.firstConversation === undefined, "🔴 …and stamps nothing: a person seen before never gets the offer");
  ok((await enrollFromBinding(roomOf("UCAL", "CROOM"))) === "skipped", "a room turn stamps no person");
  const raw = state.parseWatchState(JSON.stringify({ dial: "less", firstConversation: { since: T0, surfaceKey: "slack/T1/DX", outcome: "garbled" } }));
  ok(raw.firstConversation?.outcome === "declined", "a stored outcome that does not parse reads as declined");
}

console.log("§3 the DM block");
{
  const anaSince = (await state.readPersonalWatch(ORG, "slack/T1/UANA")).state!.firstConversation!.since;
  const soon = new Date(Date.parse(anaSince) + 60_000).toISOString();
  ok((await block(dmOf("UANA", "DANA"), soon)) === fr.DM_FIRST_CONVERSATION_BLOCK, "🔴 Ana's first DM turn reads the DM block");
  ok((await block(dmOf("UANA", "DANA"), new Date(Date.parse(anaSince) + 3 * DAY + 1).toISOString())) === "", "🔴 …and not after the window");
  ok((await block(dmOf("UANA", "DANA"), soon, true)) === "", "a worker reads no block");
  ok((await block({ ...dmOf("UANA", "DANA"), principalAttested: true } as SurfaceBinding, soon)) === "", "a routine fire reads no block");
  ok((await block({ ...dmOf("UANA", "DANA"), trust: "external" } as SurfaceBinding, soon)) === "", "an outsider reads no block");
  ok((await block({ ...dmOf("UANA", "DANA"), mode: "mpim" } as SurfaceBinding, soon)) === "", "a group DM reads no block");
  ok((await block(dmOf("UANA", "DOTHER"), soon)) === "", "a different DM of the same person reads no block");
  ok((await block(dmOf("UBEN", "DBEN"), soon)) === "", "🔴 Ben, seen before, reads no block");
  overrideSettingsForTest({ routines: { firstConversationDays: 0 } });
  ok((await block(dmOf("UANA", "DANA"), soon)) === "", "🔴 `routines.firstConversationDays: 0` turns it off");
  overrideSettingsForTest({ routines: { firstConversationDays: 3 } });
  ok((await fr.firstConversationBlock({ binding: dmOf("UANA", "DANA"), partition: partitionOfBinding(dmOf("UANA", "DANA")), worker: false, nowIso: soon }, { readWatch: async () => ({ state: undefined, version: null, readable: false }) })) === "", "an unreadable row renders no block");
}

console.log("§4 the room");
{
  const room = roomOf("UCAL", "CNEW");
  await markSurfaceOnboarded(partitionOfBinding(room));
  const files = await getProvider().readTier(partitionOfBinding(room), SURFACE);
  const marker = fr.parseRoomFirstRoutine(files[fr.FIRST_ROUTINE_MARKER]);
  ok(files[ONBOARDED_MARKER] !== undefined && marker !== undefined && marker.since === files[ONBOARDED_MARKER], "🔴 the first introduction opens the room's offer in the same write");
  const soon = new Date(Date.parse(marker!.since) + 60_000).toISOString();
  ok((await block(room, soon)) === fr.ROOM_FIRST_CONVERSATION_BLOCK, "🔴 the room's first conversation reads the room block");
  ok((await block(room, new Date(Date.parse(marker!.since) + 3 * DAY + 1).toISOString())) === "", "…and not after the window");
  const old = roomOf("UCAL", "COLD");
  await getProvider().writeTier(partitionOfBinding(old), SURFACE, { [ONBOARDED_MARKER]: "2026-05-05T23:30:00.000Z" }, "seed");
  let reads = 0;
  const counting = async (p: import("../agent/memory/partition.js").Partition) => (reads++, getProvider().readTier(p, SURFACE));
  const oldTurn = { binding: old, partition: partitionOfBinding(old), worker: false, nowIso: soon };
  ok((await fr.firstConversationBlock(oldTurn, { readRoomTier: counting })) === "", "🔴 a room introduced before this shipped never gets the offer");
  ok((await fr.firstConversationBlock(oldTurn, { readRoomTier: counting })) === "" && reads === 1, "…and the process stops reading it");
  const oldLater = { ...oldTurn, nowIso: new Date(Date.parse(soon) + fr.ROOM_UNMARKED_RECHECK_MS + 1).toISOString() };
  ok((await fr.firstConversationBlock(oldLater, { readRoomTier: counting })) === "" && reads === 1, "…for good, not only for the recheck gap");
  const fresh = roomOf("UCAL", "CLATE");
  const freshTurn = { binding: fresh, partition: partitionOfBinding(fresh), worker: false, nowIso: soon };
  ok((await fr.firstConversationBlock(freshTurn, { readRoomTier: counting })) === "" && reads === 2, "a room with no marker yet reads as none");
  await markSurfaceOnboarded(partitionOfBinding(fresh));
  ok((await fr.firstConversationBlock(freshTurn, { readRoomTier: counting })) === "" && reads === 2, "…and is not re-read inside the recheck gap");
  const later = { ...freshTurn, nowIso: new Date(Date.parse(soon) + fr.ROOM_UNMARKED_RECHECK_MS + 1).toISOString() };
  ok((await fr.firstConversationBlock(later, { readRoomTier: counting })) === fr.ROOM_FIRST_CONVERSATION_BLOCK, "…but is read again after it, and the introduction's offer shows");
}

console.log("§5 a decline ends the offer");
{
  const kind = actionKind("routine.create")!;
  ok(typeof kind.declined === "function", "the routine card records a decline");
  const elsewhere = await kind.declined!(routineArgs(roomOf("UANA", "CELSEWHERE"), "UANA"), "UANA");
  ok(elsewhere === "rejected", "a decline with no offer to end reads as a plain rejection");
  ok((await state.readPersonalWatch(ORG, "slack/T1/UANA")).state?.firstConversation?.outcome === undefined, "🔴 …and Ana's DM offer stays open");
  const line = await kind.declined!(routineArgs(dmOf("UANA", "DANA"), "UANA"), "UANA");
  ok(line === "rejected; I won't suggest a routine again", "the decided card says what the decline recorded");
  ok((await state.readPersonalWatch(ORG, "slack/T1/UANA")).state?.firstConversation?.outcome === "declined", "🔴 a decline in her DM ends Ana's offer");
  ok((await block(dmOf("UANA", "DANA"), at(1000))) === "", "🔴 …and her DM block is gone for good");
  ok((await kind.declined!(routineArgs(dmOf("UANA", "DANA"), "UANA"), "UANA")) === "rejected", "a second decline ends nothing more");
  const room = roomOf("UCAL", "CNEW");
  ok((await kind.declined!(routineArgs(room, "UCAL"), "UCAL")).startsWith("rejected; "), "a decline in the new room ends its offer");
  const files = await getProvider().readTier(partitionOfBinding(room), SURFACE);
  ok(fr.parseRoomFirstRoutine(files[fr.FIRST_ROUTINE_MARKER])?.outcome === "declined" && files[ONBOARDED_MARKER] !== undefined, "🔴 the room marker records it, and the intro marker stays");
  fr.resetFirstRoutineMemo();
  ok((await block(room, at(1000))) === "", "🔴 …and the room block is gone");
}

console.log("§6 a routine set up ends the offer");
{
  ok((await enrollFromBinding(dmOf("UDEV", "DDEV"))) === "enrolled", "Dev's first DM turn stamps his first conversation");
  const room = roomOf("UDEV", "CSETUP");
  await markSurfaceOnboarded(partitionOfBinding(room));
  const kind = actionKind("routine.create")!;
  const line = await kind.execute(routineArgs(room, "UDEV"), "UDEV");
  ok(/routine started/u.test(line), "the card arms the routine");
  ok((await state.readPersonalWatch(ORG, "slack/T1/UDEV")).state?.firstConversation?.outcome === "set-up", "🔴 a routine Dev set up anywhere ends his DM offer");
  const files = await getProvider().readTier(partitionOfBinding(room), SURFACE);
  ok(fr.parseRoomFirstRoutine(files[fr.FIRST_ROUTINE_MARKER])?.outcome === "set-up", "🔴 …and the room's offer");
  const ended = await fr.endFirstRoutineOffer(
    { partition: partitionOfBinding(room), decidedBy: "UDEV", outcome: "set-up", room: true },
    { recordPerson: async () => { throw new Error("store down"); }, readRoomTier: async () => { throw new Error("store down"); } },
  );
  ok(!ended.person && !ended.room, "a store that does not answer ends nothing, and never throws");
}

console.log("§7 the seat prompt");
{
  const ctxFor = (person: string, dm: string) => ({
    channel: { kind: "slack" },
    session: { auth: { current: { principalId: person, attributes: { oe_platform: "slack", team_id: "T1", channel_id: dm, channel_type: "im", user_id: person, dm_partner_trust: "internal" } } } },
  });
  ok((await enrollFromBinding(dmOf("UEVE", "DEVE"))) === "enrolled", "Eve's first DM turn stamps her first conversation");
  const prompt = await renderScopeMarkdown(ctxFor("UEVE", "DEVE") as never);
  ok(prompt.includes("### Your first conversation with this person"), "🔴 the REAL seat prompt of Eve's first DM turn carries the block");
  ok(prompt.trimEnd().endsWith(fr.DM_FIRST_CONVERSATION_BLOCK.trimEnd()), "…appended last, so the standing prefix stays a cache prefix");
  ok(!(await renderScopeMarkdown(ctxFor("UBEN", "DBEN") as never)).includes("first conversation"), "🔴 Ben's DM prompt has no block");
  await actionKind("routine.create")!.declined!(routineArgs(dmOf("UEVE", "DEVE"), "UEVE"), "UEVE");
  ok(!(await renderScopeMarkdown(ctxFor("UEVE", "DEVE") as never)).includes("first conversation"), "🔴 the block drops out on the turn after her decline");
}

console.log("§7b a routine card that posts is the offer");
{
  (await import("../agent/channels/slack-bridge.js")).registerSlackBridge({
    form: async () => ({ ok: true, ts: "1700000000.0001" }),
    readCall: async () => {
      throw new Error("not wired in this test");
    },
    fetchUserDisplayName: async () => undefined,
    fetchChannelDisplayName: async () => undefined,
    botDisplayName: async () => undefined,
    confirmChannelInternal: async () => true,
    partnerFactsFromInfo: () => ({ dmPartnerTrust: "internal" }),
    channel: {} as never,
  } as never);
  const createTool = (await import("../agent/tools/create_routine.js")).default as unknown as { execute(input: unknown, ctx: unknown): Promise<{ pending?: boolean }> };
  const ctx = (person: string, attrs: Record<string, string>) => ({
    channel: { kind: "slack" },
    session: { auth: { current: { principalId: person, principalType: "slack-user", attributes: { oe_platform: "slack", team_id: "T1", user_id: person, ...attrs } } } },
  });
  const trigger = { kind: "scheduled", cron: "0 9 * * 1", postPolicy: "every-run" };
  fr.resetFirstRoutineMemo();
  ok((await enrollFromBinding(dmOf("UFAY", "DFAY"))) === "enrolled", "Fay's first DM turn stamps her first conversation");
  ok((await block(dmOf("UFAY", "DFAY"), new Date(Date.now() + 1000).toISOString())) === fr.DM_FIRST_CONVERSATION_BLOCK, "her DM block is open");
  const dm = await createTool.execute({ prompt: "Send me a digest of my open tickets.", trigger }, ctx("UFAY", { channel_id: "DFAY", channel_type: "im", dm_partner_trust: "internal" }));
  ok(dm.pending === true, "the real create_routine posts a card in her DM");
  ok((await state.readPersonalWatch(ORG, "slack/T1/UFAY")).state?.firstConversation?.outcome === "offered", "🔴 the posted card records the offer as made");
  ok((await block(dmOf("UFAY", "DFAY"), new Date(Date.now() + 1000).toISOString())) === "", "🔴 …so her DM block is gone though nobody pressed the card");
  const pending = (await (await import("../agent/operational/provider.js")).getOperationalStore().listPendingActions(ORG)).find((r) => r.kind === "routine.create" && r.argsJson.includes("DFAY"))!;
  const frozen = JSON.parse(pending.argsJson) as RoutineCreateArgs;
  ok(frozen.firstRoutineRoom === undefined, "a DM card freezes no room flag");
  ok((await actionKind("routine.create")!.declined!(frozen, "UFAY")) === "rejected; I won't suggest a routine again", "a later decline of that card still says what it recorded");
  ok((await state.readPersonalWatch(ORG, "slack/T1/UFAY")).state?.firstConversation?.outcome === "declined", "…and the record says how it ended");
  const room = roomOf("UFAY", "CFRESH");
  await markSurfaceOnboarded(partitionOfBinding(room));
  const r = await createTool.execute({ prompt: "Post the open bugs.", trigger }, ctx("UFAY", { channel_id: "CFRESH", channel_type: "channel", trust_checked: "true" }));
  ok(r.pending === true, "the real create_routine posts a card in the new room");
  const files = await getProvider().readTier(partitionOfBinding(room), SURFACE);
  ok(fr.parseRoomFirstRoutine(files[fr.FIRST_ROUTINE_MARKER])?.outcome === "offered", "🔴 the posted card records the room's offer as made");
  fr.resetFirstRoutineMemo();
  ok((await block(room, new Date(Date.now() + 1000).toISOString())) === "", "🔴 …so the room block is gone");
  const roomPending = (await (await import("../agent/operational/provider.js")).getOperationalStore().listPendingActions(ORG)).find((x) => x.kind === "routine.create" && x.argsJson.includes("CFRESH"))!;
  const frozenRoom = JSON.parse(roomPending.argsJson) as RoutineCreateArgs;
  ok(frozenRoom.firstRoutineRoom === true, "🔴 a real room card freezes the room flag");
  ok((await actionKind("routine.create")!.declined!(frozenRoom, "UFAY")).startsWith("rejected; "), "…so declining it records the answer");
  const after = await getProvider().readTier(partitionOfBinding(room), SURFACE);
  ok(fr.parseRoomFirstRoutine(after[fr.FIRST_ROUTINE_MARKER])?.outcome === "declined", "🔴 …on the room marker");
}

console.log("§7c the costs");
{
  fr.resetFirstRoutineMemo();
  let watchReads = 0;
  const readWatch = async (o: string, k: string) => (watchReads++, state.readPersonalWatch(o, k));
  const ben = { binding: dmOf("UBEN", "DBEN"), partition: partitionOfBinding(dmOf("UBEN", "DBEN")), worker: false, nowIso: new Date().toISOString() };
  ok((await fr.firstConversationBlock(ben, { readWatch })) === "" && (await fr.firstConversationBlock(ben, { readWatch })) === "" && watchReads === 1, "🔴 a person with no stamp is read once per process");
  const nobody = { binding: dmOf("UNEW", "DNEW"), partition: partitionOfBinding(dmOf("UNEW", "DNEW")), worker: false, nowIso: new Date().toISOString() };
  await fr.firstConversationBlock(nobody, { readWatch });
  await fr.firstConversationBlock(nobody, { readWatch });
  ok(watchReads === 3, "a person with no row yet is read again, because the enrolment may still create it");
  let roomReads = 0;
  const readRoomTier = async () => (roomReads++, {});
  await fr.endFirstRoutineOffer({ partition: partitionOfBinding(dmOf("UBEN", "DBEN")), decidedBy: "UBEN", outcome: "declined", room: false }, { readRoomTier });
  await fr.endFirstRoutineOffer({ partition: partitionOfBinding(dmOf("UBEN", "DBEN")), decidedBy: "UBEN", outcome: "set-up", room: false }, { readRoomTier });
  ok(roomReads === 0, "🔴 a DM card's decision never reads the DM's personal memory tier");
}

console.log("§8 the eval scorer");
{
  const byId = (id: string) => FIRST_ROUTINE_CASES.find((c) => c.id === id)!;
  ok(FIRST_ROUTINE_CASES.some((c) => c.expect === "offer") && FIRST_ROUTINE_CASES.some((c) => c.expect === "no-offer"), "the pool is two-sided");
  const offerCase = byId("dm-says-what-they-do");
  const good = [
    { name: "reply", input: { text: "Happy to help with tickets. Want me to send you a digest of the open tickets every Monday at 9:00?" } },
    { name: "work", input: { brief: "Create a routine: every Monday at 09:00, a digest of the EU team's open tickets in this DM." } },
  ];
  ok(scoreFirstRoutineTurn(offerCase, good).pass, "GREEN: one plain offer and its hand-off pass");
  ok(!scoreFirstRoutineTurn(offerCase, [good[0]!]).pass, "RED: an offer with no hand-off fails");
  ok(!scoreFirstRoutineTurn(offerCase, [{ name: "reply", input: { text: "I can help with lots of things!" } }]).pass, "RED: no offer fails the offer case");
  ok(!scoreFirstRoutineTurn(offerCase, [{ name: "reply", input: { text: "Want me to post in D0123456789 every Monday?" } }, good[1]!]).pass, "RED: a raw id fails");
  ok(!scoreFirstRoutineTurn(offerCase, [good[0]!, good[0]!, good[1]!]).pass, "RED: two offers fail");
  const quiet = [{ name: "reply", input: { text: "72°F is about 22°C." } }];
  ok(scoreFirstRoutineTurn(byId("dm-quick-question"), quiet).pass, "GREEN: a plain answer passes the quick question");
  ok(!scoreFirstRoutineTurn(byId("dm-quick-question"), [...quiet, ...good]).pass, "RED: an offer that nothing said fits fails");
  ok(!scoreFirstRoutineTurn(byId("dm-after-decline"), [{ name: "reply", input: { text: "Gross is before tax. Want me to send that every Friday?" } }]).pass, "RED: an offer after a no fails");
  ok(!scoreFirstRoutineTurn(byId("dm-quick-question"), []).pass, "RED: a turn with no reply fails");
}

removeTempDir(tmp);
console.log(`✓ first-routine: ${n} assertions`);
