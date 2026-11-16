// proves: cover.set, cover.wake, cover.answered, cover.recap, cover.recap_refused

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-cover-"));
process.env.OE_SQLITE_PATH = join(tmp, "cover.sqlite3");

const { readAudit } = await import("../agent/audit/audit.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const state = await import("../agent/cover/state.js");
const wake = await import("../agent/cover/wake.js");
const recap = await import("../agent/cover/recap.js");
const { parseOeCommandTokens, runOeCommand, renderHelp } = await import("../agent/commands/core.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const { postReply, replyAuditFor } = await import("../agent/channels/reply-post.js");
const { postUnifiedReply } = await import("../agent/channels/unified-reply.js");
const { registerDomainMembershipProbe } = await import("../agent/access/domain-membership.js");
const { FIRE_PRINCIPAL_ATTR, FIRE_UNATTENDED_ATTR } = await import("../agent/identity/binding.js");
const { COVER_RECAP_MARKER_ATTR } = await import("../agent/routines/fire-auth.js");
const { OE_TAINTED_FIRE_ATTR } = await import("../agent/access/deprecated-taint-exports.js");
type SurfaceBinding = import("../agent/identity/binding.js").SurfaceBinding;
type ReplyTarget = import("../agent/channels/reply-post.js").ReplyTarget;
type CoverRecapDelivery = import("../agent/cover/recap.js").CoverRecapDelivery;

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
const NOW = new Date("2026-10-14T10:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const ANA = "slack/T1/UANA";
const anaDm: SurfaceBinding = { org: ORG, platform: "slack", workspace: "T1", surface: "DANA", mode: "dm", visibility: "private", trust: "internal", principalId: "UANA" } as SurfaceBinding;
const rows = async (action: string, principalId: string) => readAudit({ org: ORG, action, principalId });
const roomWake = (over: Partial<Parameters<typeof wake.coverForWake>[0]> = {}): Parameters<typeof wake.coverForWake>[0] => ({
  org: ORG,
  platform: "slack",
  workspace: "T1",
  surface: "CLAUNCH",
  surfaceKey: "slack/T1/CLAUNCH",
  channelId: "CLAUNCH",
  roomPublic: true,
  wakeId: "wk-1",
  mentionedIds: ["UANA"],
  askerId: "UBO",
  askerName: "Bo",
  text: "<@UANA> is the launch still on Friday?",
  now: NOW,
  ...over,
});

console.log("§1 the command");
{
  ok(JSON.stringify(parseOeCommandTokens(["cover"])) === JSON.stringify({ kind: "cover", action: "status" }), "`cover` alone reads the setting");
  ok(JSON.stringify(parseOeCommandTokens(["cover", "on", "until", "2026-10-20"])) === JSON.stringify({ kind: "cover", action: "on", until: "2026-10-20T00:00:00.000Z" }), "`cover on until <date>` parses to the start of that day, UTC");
  ok(parseOeCommandTokens(["cover", "on", "until", "Friday"]).kind === "error", "a date that is not year-month-day is an error, never a change");
  ok(parseOeCommandTokens(["cover", "loud"]).kind === "error", "an unknown action is an error");
  ok(renderHelp().includes("cover on|off"), "`/oe help` names the command");

  ok((await runOeCommand({ kind: "cover", action: "status" }, anaDm)).startsWith("Cover is off."), "status: a person who never opted in has cover off");
  ok((await getOperationalStore().getPersonalCover(ORG, ANA)) === null, "…and a status read writes no row");
  const inRoom = { ...anaDm, surface: "CLAUNCH", mode: "channel", visibility: "public" } as SurfaceBinding;
  ok((await runOeCommand({ kind: "cover", action: "on" }, inRoom)).startsWith("Turn cover on from your direct message"), "`on` from a channel is refused: opt-in is from the person's own DM");
  const outsider = { ...anaDm, principalId: "UOUT", trust: "external" } as SurfaceBinding;
  ok((await runOeCommand({ kind: "cover", action: "on" }, outsider)).startsWith("Cover is for members"), "an outsider cannot turn cover on");
  ok((await getOperationalStore().getPersonalCover(ORG, "slack/T1/UOUT")) === null, "…and no row is written for them");
  const attested = { ...anaDm, principalAttested: true as const };
  ok((await runOeCommand({ kind: "cover", action: "on" }, attested)).startsWith("I could not tell who you are"), "an ATTESTED principal (a fire) cannot turn anybody's cover on");
  ok((await runOeCommand({ kind: "cover", action: "on", until: "2026-10-13T00:00:00.000Z" }, anaDm)).startsWith("That date has already started"), "an end date in the past is refused");

  const on = await runOeCommand({ kind: "cover", action: "on" }, anaDm);
  ok(on.startsWith("Done. Cover is on.") && !/U[A-Z0-9]{3,}|slack\//.test(on), "`on` from the DM turns cover on, and the answer carries no raw id");
  ok((await state.readPersonalCover(ORG, ANA)).state?.on === true, "…in the store, under the qualified key");
  ok((await rows("cover.set", ANA)).some((r) => r.detail?.["on"] === true && r.detail?.["via"] === "command"), "…and files one cover.set row");
  ok((await runOeCommand({ kind: "cover", action: "on" }, anaDm)).startsWith("It was already on."), "a repeat says so");
  ok((await runOeCommand({ kind: "cover", action: "status" }, anaDm)).startsWith("Cover is on. Nobody has asked for you yet."), "status reads cover on");
  await state.updatePersonalCover(ORG, ANA, (s) => ({ ...s, name: "Ana <!channel>" }));
}

console.log("§2 the cover wake");
{
  const r = await wake.coverForWake(roomWake());
  ok(r.covered.length === 1 && r.covered[0]!.principalKey === ANA, "a mention of a person with live cover covers them");
  ok(r.systemNote !== undefined && r.systemNote.includes("person UANA") && r.systemNote.includes("away with cover on"), "the wake gets OE's cover note, naming the person by id");
  ok(!r.systemNote!.includes("Ana"), "🔴 the trusted note carries no display name — a name is text the person chose");
  ok(/do not act as them/.test(r.systemNote!) && /commit to anything on their behalf/.test(r.systemNote!) && /If you do not know, say so/.test(r.systemNote!), "the note forbids commitments and acting as the person, and asks for honesty about not knowing");
  const logged = (await state.readPersonalCover(ORG, ANA)).state!;
  ok(logged.entries.length === 1 && logged.entries[0]!.question.startsWith("<@UANA> is the launch") && logged.entries[0]!.askerName === "Bo", "the question enters the person's recap log");
  ok((await rows("cover.wake", ANA)).some((x) => x.detail?.["wakeId"] === "wk-1" && x.detail?.["recorded"] === true), "…and files one cover.wake row");
  await wake.coverForWake(roomWake());
  ok((await state.readPersonalCover(ORG, ANA)).state!.entries.length === 1, "the same wake id recorded twice keeps one entry");

  ok((await wake.coverForWake(roomWake({ wakeId: undefined, mentionedIds: ["UANA"] }))).systemNote === undefined, "🔴 no wake id, no cover: a reply could not carry the label");
  ok((await wake.coverForWake(roomWake({ wakeId: "wk-self", askerId: "UANA" }))).systemNote === undefined, "a person's own mention of themselves is no cover question");
  ok((await wake.coverForWake(roomWake({ wakeId: "wk-cy", mentionedIds: ["UCY"] }))).systemNote === undefined, "a person who never opted in is not covered");
  const many = Array.from({ length: 9 }, (_, i) => `UX${i}`);
  ok((await wake.coverForWake(roomWake({ wakeId: "wk-many", mentionedIds: [...many, "UANA"] }))).covered.length === 0, `a message that tags a crowd looks up at most ${wake.COVER_MAX_MENTIONS} people`);

  const store = getOperationalStore();
  const realGet = store.getPersonalCover.bind(store);
  (store as { getPersonalCover: typeof store.getPersonalCover }).getPersonalCover = async () => {
    throw new Error("store down");
  };
  ok((await wake.coverForWake(roomWake({ wakeId: "wk-down" }))).systemNote === undefined, "🔴 a store that does not answer covers nobody");
  (store as { getPersonalCover: typeof store.getPersonalCover }).getPersonalCover = realGet;

  await state.updatePersonalCover(ORG, "slack/T1/UDEE", () => ({ ...state.freshCoverState(NOW.toISOString()), on: true, until: "2026-10-14T09:00:00.000Z" }));
  ok((await wake.coverForWake(roomWake({ wakeId: "wk-dee", mentionedIds: ["UDEE"] }))).systemNote === undefined, "an end date that passed covers nobody");
  ok(state.coverLive(state.parseCoverState('{"on":"yes"}'), NOW) === false, "a row that does not parse its `on` reads as cover off");
  const e = (inRoom: unknown) => JSON.stringify({ on: true, setAt: "x", entries: [{ wakeId: "w", at: "a", platform: "teams", channelId: "c", surfaceKey: "k", inRoom }] });
  ok(state.parseCoverState(e(true)).entries[0]!.inRoom === true, "a stored `inRoom: true` survives the parse");
  ok(state.parseCoverState(e("yes")).entries[0]!.inRoom === undefined, "🔴 any other stored `inRoom` reads as not confirmed");
  const ROOM = "slack/T1/UROOM";
  await state.updatePersonalCover(ORG, ROOM, () => ({ ...state.freshCoverState(NOW.toISOString()), on: true }));
  const roomEntry = async (wakeId: string) => (await state.readPersonalCover(ORG, ROOM)).state!.entries.find((x) => x.wakeId === wakeId);
  const confirmed = await wake.coverForWake(roomWake({ wakeId: "wk-room-1", mentionedIds: ["UROOM"], roomPublic: false, confirmInRoom: async () => true }));
  ok(confirmed.systemNote !== undefined, "precondition: the wake covers the person");
  ok((await roomEntry("wk-room-1"))?.inRoom === true, "a room the surface confirms marks the question in-room");
  await wake.coverForWake(roomWake({ wakeId: "wk-room-2", mentionedIds: ["UROOM"], roomPublic: false, confirmInRoom: async () => { throw new Error("roster down"); } }));
  const down = await roomEntry("wk-room-2");
  ok(down !== undefined && down.inRoom === undefined, "🔴 a check that throws confirms nothing, and the question is still recorded");
  let asked = 0;
  await wake.coverForWake(roomWake({ wakeId: "wk-room-3", mentionedIds: ["UROOM"], roomPublic: true, confirmInRoom: async () => (asked++, true) }));
  ok(asked === 0 && (await roomEntry("wk-room-3"))?.inRoom === undefined, "a public room asks no check: it already passes the recap");
  const { shown, leftOut } = await recap.readableEntries(ROOM, (await state.readPersonalCover(ORG, ROOM)).state!.entries);
  ok(shown.map((x) => x.wakeId).sort().join(",") === "wk-room-1,wk-room-3" && leftOut === 1, "🔴 the recap shows the confirmed and the public question, and leaves the unconfirmed private one out");
  await state.updatePersonalCover(ORG, ROOM, () => state.freshCoverState(NOW.toISOString()));
}

console.log("§3 the label");
{
  ok(wake.renderCoverLabel([{ name: "Ana <!channel>" }]) === "Cover for Ana !channel, who is away:", "the label strips markup a surface would act on");
  ok(wake.renderCoverLabel([{}]) === "Cover for the person you mentioned, who is away:", "a missing name still labels, with no id");

  const posted: string[] = [];
  const surfacePosted: string[] = [];
  registerPostArm({
    platform: "cover-surface",
    dispatchReply: async (_t: unknown, text: string) => (surfacePosted.push(text), `m-${surfacePosted.length}`),
    dispatchUnified: async (_o: unknown, text: string) => (posted.push(text), `u-${posted.length}`),
  } as never);
  const deps = {};
  const origin = { platform: "cover-surface", channelId: "CLAUNCH" } as never;
  const ctx = { session: { id: "sess-cover" } } as never;
  const unified = (text: string, wakeId: string | undefined) => postUnifiedReply(origin, text, deps as never, replyAuditFor(ctx, "tool", wakeId));

  await unified("Yes, launch is Friday per the plan in this channel.", "wk-1");
  ok(posted[0] === "Cover for Ana !channel, who is away:\nYes, launch is Friday per the plan in this channel.", "🔴 a reply through the unified door on a cover wake starts with the HOST's label, whatever the model wrote");
  const entry = (await state.readPersonalCover(ORG, ANA)).state!.entries[0]!;
  ok(entry.answer === "Yes, launch is Friday per the plan in this channel.", "the reply's own text (without the label) becomes the answer in the recap log");
  ok((await rows("cover.answered", ANA)).length === 1, "…and files one cover.answered row");
  await unified("One more thing.", "wk-1");
  ok(posted[1]!.startsWith("Cover for Ana") && (await state.readPersonalCover(ORG, ANA)).state!.entries[0]!.answer!.startsWith("Yes, launch"), "a second reply on the wake is labelled too, and the first answer stands");
  await unified("Cover for Ana !channel, who is away:\nalready labelled", "wk-1");
  ok(posted[2] === "Cover for Ana !channel, who is away:\nalready labelled", "a body that already starts with the label is not labelled twice");
  await unified("An ordinary answer.", "wk-other");
  ok(posted[3] === "An ordinary answer.", "a reply on a wake that covered nobody is byte-identical");
  await unified("No wake at all.", undefined);
  ok(posted[4] === "No wake at all.", "a reply with no wake id is byte-identical");

  const store = getOperationalStore();
  const realGet = store.getTaskResult.bind(store);
  (store as { getTaskResult: typeof store.getTaskResult }).getTaskResult = async (o, k) => (k.startsWith("cover-wake:") ? null : realGet(o, k));
  const before = posted.length;
  await unified("One more thing.", "wk-1");
  (store as { getTaskResult: typeof store.getTaskResult }).getTaskResult = realGet;
  ok(posted.length === before, "a re-run whose pointer read misses dedupes against the labelled post (no second, unlabelled post)");

  const target = { platform: "cover-surface" } as unknown as ReplyTarget;
  await postReply(target, "Per-surface answer.", replyAuditFor(ctx, "tool", "wk-1"));
  ok(surfacePosted[0] === "Cover for Ana !channel, who is away:\nPer-surface answer.", "postReply labels a reply on a cover wake the same way");
}

console.log("§4 the recap");
{
  await wake.coverForWake(roomWake({ wakeId: "wk-2", surface: "GSECRET", surfaceKey: "slack/T1/GSECRET", channelId: "GSECRET", roomPublic: false, text: "<@UANA> what's the secret budget?", now: later(1) }));
  await wake.coverForWake(roomWake({ wakeId: "wk-3", askerName: undefined, text: "<@UANA> who owns the rollout doc?", now: later(2) }));
  const deliveries: CoverRecapDelivery[] = [];
  const deliver = async (d: CoverRecapDelivery) => (deliveries.push(d), { ok: true as const, surfaceKey: "slack/T1/DANA" });

  await recap.coverRecapTick({ deliver, now: later(3) });
  ok(deliveries.length === 0, "no recap while cover is still on");

  const off = await runOeCommand({ kind: "cover", action: "off" }, { ...anaDm, surface: "CLAUNCH", mode: "channel" } as SurfaceBinding);
  ok(off.startsWith("Cover is off. I'll send you a recap of the 3 questions"), "`off` works from a channel too, and says a recap is coming");
  ok((await rows("cover.set", ANA)).some((r) => r.detail?.["on"] === false && r.detail?.["questions"] === 3), "…and files cover.set with on:false");
  ok((await wake.coverForWake(roomWake({ wakeId: "wk-after", now: later(4) }))).systemNote === undefined, "🔴 turning cover off stops it: the next mention gets no note");

  await recap.coverRecapTick({ deliver, now: later(5) });
  ok(deliveries.length === 1 && deliveries[0]!.principalKey === ANA, "the tick delivers ONE recap to the person");
  const msg = deliveries[0]!.message;
  const fenceAt = msg.indexOf("<untrusted_external_data");
  ok(msg.startsWith(recap.COVER_RECAP_TAG) && fenceAt > 0 && msg.indexOf("is the launch still on Friday") > fenceAt, "the recap opens with the tag, and other people's questions sit inside the fence");
  ok(msg.includes('Bo in <#CLAUNCH>, 14 Oct: "<@UANA> is the launch still on Friday?" — I answered: "Yes, launch is Friday'), "a line says who asked, where, the question and the answer");
  ok(msg.includes('Someone in <#CLAUNCH>, 14 Oct: "<@UANA> who owns the rollout doc?" — I did not answer it.'), "an unanswered question says so, and a missing name reads as Someone");
  ok(!msg.includes("secret budget") && msg.includes("I left out 1 more from rooms I could not confirm you are in."), "🔴 a private room with no proof of membership is left out, and only counted");
  ok(deliveries[0]!.questions === 2, "the recap counts the questions it shows");
  ok((await rows("cover.recap", ANA)).some((r) => r.detail?.["questions"] === 2 && r.detail?.["leftOut"] === 1), "…and files one cover.recap row");
  const after = (await state.readPersonalCover(ORG, ANA)).state!;
  ok(after.entries.length === 0 && after.recapDue === false, "the delivered recap empties the log");
  await recap.coverRecapTick({ deliver, now: later(6) });
  ok(deliveries.length === 1, "a second tick sends nothing: the recap is never sent twice");

  const EVA = "slack/T1/UEVA";
  await state.updatePersonalCover(ORG, EVA, () => ({ ...state.freshCoverState(NOW.toISOString()), on: true, since: NOW.toISOString() }));
  await wake.coverForWake(roomWake({ wakeId: "wk-e1", mentionedIds: ["UEVA"], surface: "GTEAM", surfaceKey: "slack/T1/GTEAM", channelId: "GTEAM", roomPublic: false, text: "<@UEVA> status of the audit?" }));
  registerDomainMembershipProbe("slack", async (q) => ({ fullMember: q.principalId === "UEVA", rooms: [{ domain: "team", surfaceKey: "slack/T1/GTEAM", origin: { platform: "slack", channelId: "GTEAM" } }] }));
  await state.turnCoverOff({ org: ORG, platform: "slack", workspace: "T1", surface: "DEVA", principalKey: EVA }, "command");
  await recap.coverRecapTick({ deliver, now: later(7) });
  ok(deliveries.length === 2 && deliveries[1]!.message.includes("status of the audit?") && !deliveries[1]!.message.includes("left out"), "a private room the probe confirms the person sits in is shown");

  const FAY = "slack/T1/UFAY";
  await state.updatePersonalCover(ORG, FAY, () => ({ ...state.freshCoverState(NOW.toISOString()), on: true, since: NOW.toISOString(), until: later(30).toISOString() }));
  await wake.coverForWake(roomWake({ wakeId: "wk-f1", mentionedIds: ["UFAY"], text: "<@UFAY> ping" }));
  await recap.coverRecapTick({ deliver, now: later(10) });
  ok((await state.readPersonalCover(ORG, FAY)).state!.on === true && deliveries.length === 2, "before the end date, cover stays on and no recap goes");
  const report = await recap.coverRecapTick({ deliver, now: later(31) });
  ok(report.ended === 1 && (await state.readPersonalCover(ORG, FAY)).state!.on === false, "after the end date, the tick turns cover off");
  ok((await rows("cover.set", FAY)).some((r) => r.detail?.["via"] === "end-date"), "…filed as via end-date");
  ok(deliveries.length === 3 && deliveries[2]!.principalKey === FAY, "…and the recap goes in the same tick");

  const GUS = "slack/T1/UGUS";
  await state.updatePersonalCover(ORG, GUS, () => ({ ...state.freshCoverState(NOW.toISOString()), on: true, since: NOW.toISOString() }));
  await wake.coverForWake(roomWake({ wakeId: "wk-g1", mentionedIds: ["UGUS"], text: "<@UGUS> ping" }));
  await state.turnCoverOff({ org: ORG, platform: "slack", workspace: "T1", surface: "DGUS", principalKey: GUS }, "command");
  const refuse = async () => ({ ok: false as const, reason: "no DM" });
  await recap.coverRecapTick({ deliver: refuse, now: later(40) });
  ok((await state.readPersonalCover(ORG, GUS)).state!.entries.length === 1, "a refused recap keeps the log for the next try");
  await recap.coverRecapTick({ deliver: refuse, now: later(41) });
  const tried = (await state.readPersonalCover(ORG, GUS)).state!;
  ok(tried.recapTries === 2 && tried.recapClaimAt === undefined && tried.entries.length === 1, "the released claim lets the next tick try again, and each try counts");
  for (let i = 0; i < state.COVER_RECAP_MAX_TRIES; i++) await recap.coverRecapTick({ deliver: refuse, now: later(50 + i) });
  const gus = (await state.readPersonalCover(ORG, GUS)).state!;
  ok(gus.entries.length === 0 && gus.recapDue === false, `after ${state.COVER_RECAP_MAX_TRIES} refused tries the tick drops the log`);
  ok((await rows("cover.recap_refused", GUS)).some((r) => r.detail?.["gaveUp"] === true), "…and files cover.recap_refused with gaveUp");

  const HAL = "slack/T1/UHAL";
  await state.updatePersonalCover(ORG, HAL, () => ({ ...state.freshCoverState(NOW.toISOString()), on: true, since: NOW.toISOString() }));
  await wake.coverForWake(roomWake({ wakeId: "wk-h1", mentionedIds: ["UHAL"], text: "<@UHAL> ping" }));
  await state.turnCoverOff({ org: ORG, platform: "slack", workspace: "T1", surface: "DHAL", principalKey: HAL }, "command");
  await state.updatePersonalCover(ORG, HAL, (s) => ({ ...s, recapClaimAt: later(59).toISOString() }));
  const before = deliveries.length;
  await recap.coverRecapTick({ deliver, now: later(60) });
  ok(deliveries.length === before, "a recap another tick claimed moments ago is not sent again");
  await recap.coverRecapTick({ deliver, now: later(60 + 11) });
  ok(deliveries.length === before + 1, "a stale claim (its tick died) is taken over");
}

console.log("§5 the delivery");
{
  const sent: { message: string; auth: { attributes?: Record<string, unknown> } }[] = [];
  const to = ((_c: unknown, _t: unknown) => ({ send: async (message: string, opts: { auth: { attributes?: Record<string, unknown> } }) => void sent.push({ message, auth: opts.auth }) })) as never;
  const dmTarget = async () => ({ ok: true as const, surfaceKey: "slack/T1/DANA", dispatch: { channel: {} as never, target: { channelId: "DANA" }, mode: "dm" as const, attributes: { team_id: "T1", channel_id: "DANA", channel_type: "im" } } });
  const d = { org: ORG, principalKey: ANA, message: "recap", questions: 2, now: NOW };
  const r = await recap.deliverCoverRecap({ to, appAuth: { attributes: {} } as never, resolveTarget: dmTarget as never }, d);
  ok(r.ok && sent.length === 1, "a DM target is sent to");
  const attrs = sent[0]!.auth.attributes ?? {};
  ok(attrs[FIRE_UNATTENDED_ATTR] === "true" && attrs[FIRE_PRINCIPAL_ATTR] === "UANA", "the fire is unattended, with the person as the ATTESTED principal");
  ok(attrs["oe_grain"] === "standing" && attrs[OE_TAINTED_FIRE_ATTR] === undefined, "the DM standing grain rides the fire, and no taint stamp does (OPE-2720)");
  ok(attrs[COVER_RECAP_MARKER_ATTR] === "2", "the marker counts the questions");
  const roomTarget = async () => ({ ok: true as const, surfaceKey: "slack/T1/C1", dispatch: { channel: {} as never, target: { channelId: "C1" }, mode: "channel" as const, attributes: {} } });
  const refused = await recap.deliverCoverRecap({ to, appAuth: { attributes: {} } as never, resolveTarget: roomTarget as never }, d);
  ok(!refused.ok && sent.length === 1, "🔴 a target that is not a 1:1 DM is refused, so a recap never reaches a room");
}

console.log(`✓ cover: ${n} assertions`);
removeTempDir(tmp);
