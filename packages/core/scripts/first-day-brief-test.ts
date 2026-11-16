import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-first-day-brief-"));
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

const fdb = await import("../agent/onboarding/first-day-brief.js");
const fr = await import("../agent/onboarding/first-routine.js");
const state = await import("../agent/personal-watch/state.js");
const { onDmTurn } = await import("../agent/hooks/personal-watch-enroll.js");
const { proposeFirstDayBriefCard } = await import("../agent/personal-watch/propose.js");
const { applyWatchObservation, renderWatchMessage, isEmptyWatchState, WATCH_EMPTY_STATE } = await import("../agent/routines/watch.js");
const { listRoutines } = await import("../agent/routines/store.js");
const { partitionOfBinding } = await import("../agent/memory/partition.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
await import("../agent/approvals/flow.js");
const { actionKind } = await import("../agent/approvals/actions.js");
type SurfaceBinding = import("../agent/identity/binding.js").SurfaceBinding;
type FirstDayBriefArgs = import("../agent/onboarding/first-day-brief.js").FirstDayBriefArgs;
type FirstDayBriefDeps = import("../agent/onboarding/first-day-brief.js").FirstDayBriefDeps;

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
const dmOf = (person: string, dm: string): SurfaceBinding =>
  ({ org: ORG, platform: "slack", workspace: "T1", surface: dm, mode: "dm", visibility: "private", trust: "internal", principalId: person }) as SurfaceBinding;
const roomOf = (person: string, room: string): SurfaceBinding =>
  ({ org: ORG, platform: "slack", workspace: "T1", surface: room, mode: "channel", visibility: "public", trust: "internal", principalId: person }) as SurfaceBinding;

interface PostedCard {
  readonly channel: string;
  readonly text: string;
  readonly buttons: readonly string[];
}
const cards: PostedCard[] = [];
let cardSeq = 0;
let refusePosts = false;
const slackPost = async (method: string, body: string): Promise<Record<string, unknown>> => {
  if (method === "chat.postMessage") {
    if (refusePosts) return { ok: false, error: "channel_not_found" };
    const form = new URLSearchParams(body);
    const blocks = JSON.parse(form.get("blocks") ?? "[]") as { type: string; elements?: { text?: { text?: string } }[] }[];
    const buttons = blocks.filter((b) => b.type === "actions").flatMap((b) => (b.elements ?? []).map((e) => e.text?.text ?? ""));
    cards.push({ channel: form.get("channel") ?? "", text: `${form.get("text") ?? ""} ${form.get("blocks") ?? ""}`, buttons });
  }
  return { ok: true, ts: `1760000000.${String(++cardSeq).padStart(6, "0")}` };
};
const resolveTarget = async (spec: { principalId?: string }) => {
  const dm = `D${spec.principalId}`;
  return { ok: true as const, surfaceKey: `slack/T1/${dm}`, dispatch: { channel: {} as never, target: { channelId: dm }, mode: "dm" as const, attributes: {} } };
};
let stopped = new Set<string>();
const deps: FirstDayBriefDeps = {
  propose: proposeFirstDayBriefCard({ resolveTarget: resolveTarget as never, post: slackPost }),
  dmStopped: async (_org, principalKey) => stopped.has(principalKey),
};
const turn = (person: string, dm = `D${person}`) => onDmTurn(dmOf(person, dm), { firstDay: deps });
const cardsIn = (dm: string) => cards.filter((c) => c.channel === dm);
const pendingFor = async (person: string) =>
  (await getOperationalStore().listPendingActions(ORG)).filter((r) => r.kind === "routine.suggest" && r.status === "pending" && (JSON.parse(r.argsJson) as { personId?: string }).personId === person);

console.log("§1 the frozen args and the window");
{
  const a = fdb.firstDayBriefArgs({ org: ORG, principalKey: "slack/T1/UANA", personId: "UANA", surfaceKey: "slack/T1/DUANA", target: { channelId: "DUANA" } });
  ok(a.scope === "first-day" && a.fingerprint === fdb.FIRST_DAY_BRIEF_FINGERPRINT, "the card is the first-day scope of routine.suggest");
  ok(a.brief.trigger.kind === "cron" && a.brief.trigger.expr === "0 9 * * 1-5" && a.brief.firstRunNow === true, "🔴 the brief runs weekdays at 09:00 UTC, the first run at once");
  ok(a.brief.quietWhenEmpty === undefined && a.brief.report === undefined, "the brief posts every run");
  ok(a.needsYou.trigger.kind === "watch" && a.needsYou.trigger.expr === "0 11,14,17 * * 1-5" && a.needsYou.quietWhenEmpty === true, "🔴 the needs-you watch is a quiet-when-empty watch at 11, 14 and 17 UTC");
  ok(a.needsYou.firstRunNow === undefined, "the needs-you watch keeps its schedule");
  for (const c of [a.brief, a.needsYou]) {
    ok(c.createdBy === "UANA" && c.surfaceKey === "slack/T1/DUANA" && c.partition.surfaceKey === "slack/T1/DUANA", "both routines live in the person's own DM, created by the person");
    ok(c.permissions === undefined && c.tainted === undefined && c.collectors === undefined, "🔴 neither declares a standing permission, and neither is tainted");
    ok(!/U[A-Z0-9]{3,}|slack\//u.test(c.prompt), "a prompt names no person id and no key");
    ok(c.prompt.includes(fdb.WHAT_NEEDS_THEM), "both prompts read the one triage clause (the seam with OPE-2663)");
  }
  ok(a.needsYou.prompt.includes(`\`${WATCH_EMPTY_STATE}\``), "the needs-you watch records the empty word");
  const since = "2026-10-21T09:00:00.000Z";
  const row = { firstConversation: { since, surfaceKey: "slack/T1/DUANA" } };
  ok(fdb.firstDayWindowOpen(row, "slack/T1/DUANA", "2026-10-21T09:01:00.000Z", 3), "the window is open on the first DM");
  ok(!fdb.firstDayWindowOpen(row, "slack/T1/DOTHER", "2026-10-21T09:01:00.000Z", 3), "…not in another DM");
  ok(!fdb.firstDayWindowOpen(row, "slack/T1/DUANA", new Date(Date.parse(since) + 3 * DAY).toISOString(), 3), "🔴 …not after the window");
  ok(!fdb.firstDayWindowOpen({ firstConversation: { ...row.firstConversation, outcome: "declined" } }, "slack/T1/DUANA", "2026-10-21T09:01:00.000Z", 3), "🔴 …not after a no to the first-conversation offer");
  ok(fdb.firstDayWindowOpen({ firstConversation: { ...row.firstConversation, outcome: "offered" } }, "slack/T1/DUANA", "2026-10-21T09:01:00.000Z", 3), "…but a routine card that only posted does not close it");
  ok(!fdb.firstDayWindowOpen({}, "slack/T1/DUANA", "2026-10-21T09:01:00.000Z", 3), "a row with no stamp is never open");
  ok(!fdb.firstDayWindowOpen(row, "slack/T1/DUANA", "2026-10-21T09:01:00.000Z", 0), "`0` days is never open");
  const kind = actionKind("routine.suggest")!;
  const head = kind.plainSummary(a);
  const line = kind.consequence!(a)!;
  ok(head === "Want a morning brief and check-ins?", "🔴 the card's headline is the plain offer");
  ok(line.length <= 160 && /09:00 UTC/u.test(line) && /only when something needs you/u.test(line), "the one line says when, and that a check-in posts only when needed, inside the 160-character cap");
  ok(!/routine\.|first-day|U[A-Z0-9]{3,}|cron|watch/iu.test(`${head} ${line}`), "the card names no id, no kind label and no machine word");
  ok(kind.optionLabels!(a).approve === "Set it up" && kind.optionLabels!(a).reject === "No thanks", "the buttons are Set it up and No thanks");
}

console.log("§2 the first DM turn posts the card");
{
  const first = await turn("UANA");
  ok(first?.offered === true, `🔴 Ana's first DM turn posts the card (got ${JSON.stringify(first)})`);
  ok(cardsIn("DUANA").length === 1 && cardsIn("DUANA")[0]!.buttons.join("|") === "Set it up|No thanks", "…ONE card, in her own DM, with both buttons");
  ok(cardsIn("DUANA")[0]!.text.includes("Want a morning brief and check-ins?"), "…headed by the offer");
  const row = (await state.readPersonalWatch(ORG, "slack/T1/UANA")).state!;
  ok(row.proposals.some((p) => p.fingerprint === fdb.FIRST_DAY_BRIEF_FINGERPRINT && p.outcome === undefined), "🔴 the row records the card as offered, unanswered");
  const filed = (await readAudit({ org: ORG, action: "personal_watch.proposal", principalId: "slack/T1/UANA" })).filter((r) => r.detail?.["fingerprint"] === fdb.FIRST_DAY_BRIEF_FINGERPRINT);
  ok(filed.length === 1 && filed[0]!.detail?.["kind"] === "first-day-brief", "one personal_watch.proposal row names the first-day brief");
  ok((await pendingFor("UANA")).length === 1, "one pending card waits on her");
  const second = await turn("UANA");
  ok(second?.offered === false && cardsIn("DUANA").length === 1, "🔴 her next DM turn posts nothing more");
  let reads = 0;
  const counting: FirstDayBriefDeps = { ...deps, readWatch: async (o, k) => (reads++, state.readPersonalWatch(o, k)) };
  const t0 = new Date().toISOString();
  ok((await fdb.offerFirstDayBrief(dmOf("UANA", "DUANA"), "slack/T1/DUANA", counting, t0)).offered === false && reads === 0, "a settled person costs no row read");
  const later = new Date(Date.parse(t0) + fdb.FIRST_DAY_SETTLED_RECHECK_MS + 1).toISOString();
  const reread = await fdb.offerFirstDayBrief(dmOf("UANA", "DUANA"), "slack/T1/DUANA", counting, later);
  ok(reread.offered === false && reread.skipped === "already-offered" && reads === 1, "🔴 …until the memo expires: then the row is read again, so a reset row is seen");
  fdb.resetFirstDayBriefMemo();
  const third = await turn("UANA");
  ok(third?.offered === false && third.skipped === "already-offered" && cardsIn("DUANA").length === 1, "🔴 …and nor does a fresh process: the row, not the memo, holds the answer");
}

console.log("§3 who never gets the card");
{
  ok((await state.enrollPersonalWatch(ORG, "slack/T1/UBEN")) === "enrolled", "Ben was enrolled from the Home tab");
  const ben = await turn("UBEN");
  ok(ben?.offered === false && ben.skipped === "not-first-dm" && cardsIn("DUBEN").length === 0, "🔴 a person seen before never gets the card");
  ok((await onDmTurn(roomOf("UCAL", "CROOM"), { firstDay: deps })) === undefined && cards.every((c) => c.channel !== "CROOM"), "a room turn posts nothing");
  const outsider = await fdb.offerFirstDayBrief({ ...dmOf("UOUT", "DUOUT"), trust: "external" } as SurfaceBinding, "slack/T1/DUOUT", deps);
  ok(outsider.offered === false && outsider.skipped === "not-own-dm", "an outsider gets no card");
  const fire = await fdb.offerFirstDayBrief({ ...dmOf("UANA", "DUANA"), principalAttested: true } as SurfaceBinding, "slack/T1/DUANA", deps);
  ok(fire.offered === false && fire.skipped === "not-own-dm", "a routine fire in the DM posts no card");
  overrideSettingsForTest({ routines: { firstDayBrief: false } });
  const off = await turn("UDEE");
  ok(off?.offered === false && off.skipped === "off" && cardsIn("DUDEE").length === 0, "🔴 `routines.firstDayBrief: false` turns it off");
  overrideSettingsForTest({ routines: { firstDayBrief: true, firstConversationDays: 0 } });
  fdb.resetFirstDayBriefMemo();
  const noWindow = await turn("UDEE");
  ok(noWindow?.offered === false && noWindow.skipped === "off", "`routines.firstConversationDays: 0` turns it off too");
  overrideSettingsForTest({ routines: { firstConversationDays: 3 } });
  await state.updatePersonalWatch(ORG, "slack/T1/UDEE", (s) => ({ ...s, dial: "none" }));
  const none = await turn("UDEE");
  ok(none?.offered === false && none.skipped === "watch-none" && cardsIn("DUDEE").length === 0, "🔴 a person whose watch is `none` gets no card");
  await state.updatePersonalWatch(ORG, "slack/T1/UDEE", (s) => ({ ...s, dial: "less" }));
  stopped = new Set(["slack/T1/UDEE"]);
  const stop = await turn("UDEE");
  ok(stop?.offered === false && stop.skipped === "dm-stopped" && cardsIn("DUDEE").length === 0, "🔴 a person who stopped proactive DMs gets no card");
  stopped = new Set();
  const dee = await turn("UDEE");
  ok(dee?.offered === true && cardsIn("DUDEE").length === 1, "…and gets it on the next turn in the window once the stop is lifted");
  ok((await turn("UEVE"))?.offered === true, "Eve gets the card on her first DM turn");
  ok((await state.enrollPersonalWatch(ORG, "slack/T1/UFAY", new Date(Date.now() - 4 * DAY).toISOString(), { firstDm: "slack/T1/DUFAY" })) === "enrolled", "Fay's first DM was four days ago");
  const late = await turn("UFAY");
  ok(late?.offered === false && late.skipped === "not-first-dm" && cardsIn("DUFAY").length === 0, "🔴 a first DM four days ago is outside the window");
}

console.log("§4 a refused post takes the reservation back");
{
  refusePosts = true;
  const refused = await turn("UGIL");
  ok(refused?.offered === false && refused.skipped === "refused", "a post the platform refuses posts nothing");
  ok(!(await state.readPersonalWatch(ORG, "slack/T1/UGIL")).state!.proposals.some((p) => p.fingerprint === fdb.FIRST_DAY_BRIEF_FINGERPRINT), "🔴 …and the reservation is taken back");
  refusePosts = false;
  const soon = await turn("UGIL");
  ok(soon?.offered === false && soon.skipped === "settled" && cardsIn("DUGIL").length === 0, "a refusal is not retried on every turn: the memo holds it for the recheck gap");
  fdb.resetFirstDayBriefMemo();
  const retried = await turn("UGIL");
  ok(retried?.offered === true && cardsIn("DUGIL").length === 1, "🔴 a DM turn after the recheck gap posts it");
  const broken = await fdb.offerFirstDayBrief(dmOf("UHAL", "DUHAL"), "slack/T1/DUHAL", { ...deps, readWatch: async () => ({ state: undefined, version: null, readable: false }) });
  ok(broken.offered === false && broken.skipped === "no-row", "a store that does not answer posts no card, and never throws");
}

console.log("§5 Set it up arms the brief and the needs-you watch");
{
  const kind = actionKind("routine.suggest")!;
  const pending = (await pendingFor("UANA"))[0]!;
  const args = JSON.parse(pending.argsJson) as FirstDayBriefArgs;
  ok(args.scope === "first-day" && args.brief.surfaceKey === "slack/T1/DUANA", "the pending card froze the first-day args for her DM");
  let refused = "";
  try {
    await kind.execute(args, "UBEN");
  } catch (err) {
    refused = String(err);
  }
  ok(/only the person this suggestion is for/u.test(refused), "🔴 another clicker cannot arm her brief");
  ok((await listRoutines(args.brief.partition)).length === 0, "…and nothing armed");
  const before = Date.now();
  const line = await kind.execute(args, "UANA");
  ok(/morning brief and check-ins/u.test(line) && /first brief/u.test(line), `the decided card says what it set up (${line})`);
  const routines = await listRoutines(args.brief.partition);
  ok(routines.length === 2, `🔴 Set it up arms TWO routines in her DM (got ${routines.length})`);
  const brief = routines.find((r) => r.trigger.kind === "cron")!;
  const needsYou = routines.find((r) => r.trigger.kind === "watch")!;
  ok(brief !== undefined && needsYou !== undefined, "one brief and one needs-you watch");
  const briefDue = Date.parse(brief.nextRunAt ?? "");
  ok(briefDue <= Date.now() && briefDue >= before - 1000, "🔴 the brief's first run is due at once");
  ok(Date.parse(needsYou.nextRunAt ?? "") > Date.now(), "the needs-you watch waits for its schedule");
  ok(needsYou.quietWhenEmpty === true && brief.quietWhenEmpty === undefined, "🔴 only the needs-you watch is quiet when empty");
  ok(brief.createdBy === "UANA" && needsYou.createdBy === "UANA" && brief.status === "active" && needsYou.status === "active", "both are active, created by Ana");
  ok(brief.prompt === fdb.BRIEF_PROMPT && needsYou.prompt === fdb.NEEDS_YOU_PROMPT, "each carries its host-written instruction");
  const created = (await readAudit({ org: ORG, action: "routine.create" })).filter((r) => r.surface === "DUANA");
  ok(created.length === 2, "🔴 two ordinary routine.create audit rows");
  ok((await state.readPersonalWatch(ORG, "slack/T1/UANA")).state!.proposals.find((p) => p.fingerprint === fdb.FIRST_DAY_BRIEF_FINGERPRINT)?.outcome === "accepted", "the row records the answer");
  ok((await readAudit({ org: ORG, action: "personal_watch.proposal.accepted", principalId: "slack/T1/UANA" })).some((r) => r.detail?.["fingerprint"] === fdb.FIRST_DAY_BRIEF_FINGERPRINT), "personal_watch.proposal.accepted names the first-day brief");
  ok((await state.readPersonalWatch(ORG, "slack/T1/UANA")).state!.firstConversation?.outcome === "set-up", "a routine set up also ends the first-conversation offer");
}

console.log("§5b a brief that fails to arm stops the needs-you watch");
{
  const kind = actionKind("routine.suggest")!;
  const good = fdb.firstDayBriefArgs({ org: ORG, principalKey: "slack/T1/UJON", personId: "UJON", surfaceKey: "slack/T1/DUJON", target: { channelId: "DUJON" } });
  const broken = { ...good, brief: { ...good.brief, firstRunNow: undefined, trigger: { kind: "once" as const, at: "not a date" } } };
  let threw = false;
  try {
    await kind.execute(broken, "UJON");
  } catch {
    threw = true;
  }
  ok(threw, "a failed brief fails the click, so the card shows it");
  const rows = await listRoutines(good.needsYou.partition);
  ok(rows.length === 1 && rows[0]!.status === "disabled" && rows[0]!.nextRunAt === null, `🔴 the needs-you watch that armed first is stopped again (${JSON.stringify(rows.map((r) => r.status))})`);
}

console.log("§6 No thanks is remembered");
{
  const kind = actionKind("routine.suggest")!;
  const args = JSON.parse((await pendingFor("UEVE"))[0]!.argsJson) as FirstDayBriefArgs;
  let refused = "";
  try {
    await kind.declined!(args, "UANA");
  } catch (err) {
    refused = String(err);
  }
  ok(/only the person this suggestion is for/u.test(refused), "another clicker cannot decline for her");
  const line = await kind.declined!(args, "UEVE");
  ok(/won't offer this again/u.test(line), "the decided card says it is remembered");
  ok((await state.readPersonalWatch(ORG, "slack/T1/UEVE")).state!.proposals.find((p) => p.fingerprint === fdb.FIRST_DAY_BRIEF_FINGERPRINT)?.outcome === "declined", "🔴 the row records No thanks");
  ok((await listRoutines(args.brief.partition)).length === 0, "nothing armed");
  fdb.resetFirstDayBriefMemo();
  const again = await turn("UEVE");
  ok(again?.offered === false && cardsIn("DUEVE").length === 1, "🔴 the card never posts again");
}

console.log("§7 an empty needs-you check posts nothing");
{
  const quiet = { lastStateHash: undefined, quietWhenEmpty: true as const };
  const firstEmpty = applyWatchObservation(quiet, "nothing");
  ok(!firstEmpty.changed && firstEmpty.patch.lastOutcome === "skipped", "🔴 the first check, empty, posts nothing (no baseline post)");
  const full = applyWatchObservation({ ...quiet, lastStateHash: firstEmpty.patch.lastStateHash }, "PR 12 in acme/web waits on your review");
  ok(full.changed, "a check that finds something posts");
  const emptyAgain = applyWatchObservation({ ...quiet, lastStateHash: full.patch.lastStateHash }, "Nothing.");
  ok(!emptyAgain.changed && emptyAgain.patch.lastOutcome === "skipped", "🔴 an empty check after a full one posts nothing");
  const fullAgain = applyWatchObservation({ ...quiet, lastStateHash: emptyAgain.patch.lastStateHash }, "PR 12 in acme/web waits on your review");
  ok(fullAgain.changed, "…and the same item, back after an empty check, posts again");
  const plain = applyWatchObservation({ lastStateHash: full.patch.lastStateHash }, "nothing");
  ok(plain.changed, "🔴 an ordinary watch still reports a change to nothing");
  ok(applyWatchObservation({ lastStateHash: undefined }, "nothing").changed, "…and reports its baseline");
  ok(isEmptyWatchState(" NOTHING. ") && !isEmptyWatchState("nothing new in acme/web"), "only the bare word reads as empty");
  const msg = renderWatchMessage({ id: "r1", prompt: fdb.NEEDS_YOU_PROMPT, createdAt: "2026-10-21T09:00:00.000Z", quietWhenEmpty: true });
  ok(msg.includes(`record the state as exactly \`${WATCH_EMPTY_STATE}\``), "🔴 the needs-you watch's fire tells the turn the empty word");
  ok(!renderWatchMessage({ id: "r2", prompt: "Watch the status page.", createdAt: "2026-10-21T09:00:00.000Z" }).includes("If the check finds nothing"), "an ordinary watch's fire is unchanged");
}

console.log("§8 the seat block defers to the card");
{
  ok(/may already offer\s+them a morning brief and check-ins/u.test(fr.DM_FIRST_CONVERSATION_BLOCK) && /Never offer those again/u.test(fr.DM_FIRST_CONVERSATION_BLOCK), "the DM block tells the seat not to offer the brief again");
  ok(!/morning summary/u.test(fr.DM_FIRST_CONVERSATION_BLOCK), "…and no longer suggests a morning summary of its own");
}

console.log("§9 create_routine carries quietWhenEmpty");
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
  const ctx = {
    channel: { kind: "slack" },
    session: { auth: { current: { principalId: "UIVY", principalType: "slack-user", attributes: { oe_platform: "slack", team_id: "T1", user_id: "UIVY", channel_id: "DUIVY", channel_type: "im", dm_partner_trust: "internal" } } } },
  };
  const watch = { kind: "scheduled", cron: "0 12 * * 1-5", postPolicy: "only-on-change" };
  const r = await createTool.execute({ prompt: fdb.NEEDS_YOU_PROMPT, trigger: watch, quietWhenEmpty: true }, ctx);
  ok(r.pending === true, "a re-created needs-you watch posts its card");
  const row = (await getOperationalStore().listPendingActions(ORG)).find((x) => x.kind === "routine.create" && x.argsJson.includes("DUIVY"))!;
  const frozen = JSON.parse(row.argsJson) as import("../agent/approvals/routine-create.js").RoutineCreateArgs;
  ok(frozen.quietWhenEmpty === true, "🔴 the card freezes quietWhenEmpty");
  ok(actionKind("routine.create")!.summarize(frozen).includes("🤫 posts nothing when a check finds nothing"), "the card says the watch posts nothing on an empty check");
  ok(!actionKind("routine.create")!.summarize({ ...frozen, quietWhenEmpty: undefined }).some((l) => l.includes("🤫")), "…and an ordinary watch's card does not");
  let refused = "";
  try {
    await createTool.execute({ prompt: "Post the digest.", trigger: { kind: "scheduled", cron: "0 9 * * 1", postPolicy: "every-run" }, quietWhenEmpty: true }, ctx);
  } catch (err) {
    refused = String(err);
  }
  ok(/needs `postPolicy: "only-on-change"`/u.test(refused), "a clock routine that posts every run refuses the flag");
  const line = await actionKind("routine.create")!.execute(frozen, "UIVY");
  ok(/watch started|routine started/u.test(line), "the click arms it");
  const armed = (await listRoutines(frozen.partition)).find((x) => x.prompt === fdb.NEEDS_YOU_PROMPT);
  ok(armed?.quietWhenEmpty === true, "🔴 the armed row is quiet when empty");
  const listTool = (await import("../agent/tools/list_routines.js")).default as unknown as { execute(input: unknown, ctx: unknown): Promise<{ routines: { prompt: string; quietWhenEmpty: boolean }[] }> };
  const listed = (await listTool.execute({}, ctx)).routines;
  ok(listed.find((x) => x.prompt === fdb.NEEDS_YOU_PROMPT)?.quietWhenEmpty === true, "🔴 list_routines shows the flag, so a re-create can carry it");
}

void partitionOfBinding;
removeTempDir(tmp);
console.log(`✓ first-day brief: ${n} assertions`);
