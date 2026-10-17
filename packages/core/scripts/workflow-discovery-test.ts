import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-workflow-discovery-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { overrideSettingsForTest, SETTINGS } = await import("../agent/settings/settings.js");
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

const { PGlite } = await import("@electric-sql/pglite");
const { initOperationalSchema, makeOperationalPostgresStore } = await import("../agent/operational/postgres.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const discovery = await import("../agent/personal-watch/discovery.js");
const state = await import("../agent/personal-watch/state.js");
const watch = await import("../agent/personal-watch/watch.js");
const { proposeRoutineCard, proposeRoomRoutineCard } = await import("../agent/personal-watch/propose.js");
const questions = await import("../agent/personal-watch/questions.js");
const roomDiscovery = await import("../agent/personal-watch/room-discovery.js");
const ledgerHook = await import("../agent/hooks/question-ledger.js");
const { setPersonOptOut } = await import("../agent/identity/person-opt-out.js");
await import("../agent/approvals/flow.js");
const { actionKind } = await import("../agent/approvals/actions.js");
type PersonConnectorCallRow = import("../agent/operational/store.js").PersonConnectorCallRow;
type ToolUsageEntry = import("../agent/operational/store.js").ToolUsageEntry;
type PgClient = import("../agent/operational/postgres.js").PgClient;
type QuestionLedgerRow = import("../agent/operational/store.js").QuestionLedgerRow;
type RoomConnectorCallRow = import("../agent/operational/store.js").RoomConnectorCallRow;

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
const NOW = new Date("2026-10-12T10:00:00.000Z");
const MONDAYS = ["2026-09-21", "2026-09-28", "2026-10-05"];
const call = (date: string, hhmm: string, connector = "linear", tool = "list_issues"): PersonConnectorCallRow => ({ ts: `${date}T${hhmm}:00.000Z`, connector, tool });
const mondayCalls = (hours = ["09:10", "09:40", "08:55"]): PersonConnectorCallRow[] => MONDAYS.map((d, i) => call(d, hours[i]!));

console.log("§1 the detector");
{
  ok(SETTINGS.routines.discoveryMinWeeks.shipped === 3 && discovery.discoveryMinWeeks() === 3 && discovery.discoveryOn(), "shipped: discovery is ON, at three weeks");
  const found = discovery.findRepeatedWork(mondayCalls(), NOW, 3);
  ok(found.length === 1, "three Mondays in a row of the same op is one pattern");
  const w = found[0]!;
  ok(w.fingerprint === "weekly:linear/list_issues:1" && w.weekday === 1 && w.weeks === 3, "the pattern names the op and the weekday");
  ok(w.hour === 9 && discovery.proposalCron(w) === "0 9 * * 1", "the routine runs on the usual hour: the median of 08:55, 09:10 and 09:40");
  ok(discovery.repeatedWorkWords(w) === "list issues on linear", "the op reads in plain words");
  ok(!/[A-Z]\d|U[A-Z0-9]{3,}/u.test(discovery.proposalPrompt(w)) && discovery.proposalPrompt(w).includes("Ask before you change anything"), "the routine instruction is host words and asks before any change");
  ok(discovery.findRepeatedWork(mondayCalls().slice(1), NOW, 3).length === 0, "two weeks are not enough");
  ok(discovery.findRepeatedWork(mondayCalls().slice(1), NOW, 2).length === 1, "…unless the setting asks for two");
  ok(discovery.findRepeatedWork(mondayCalls(), NOW, 0).length === 0, "`0` turns the detector off");
  const daily: PersonConnectorCallRow[] = [];
  for (let d = 0; d < 21; d++) daily.push(call(new Date(Date.parse("2026-09-21T00:00:00Z") + d * 86_400_000).toISOString().slice(0, 10), "11:00"));
  ok(discovery.findRepeatedWork(daily, NOW, 3).length === 0, "an op the person runs every day is not offered as a weekly routine");
  const stale = ["2026-08-31", "2026-09-07", "2026-09-14"].map((d) => call(d, "09:00"));
  ok(discovery.findRepeatedWork(stale, NOW, 3).length === 0, "a habit with no call in the last two weeks is not offered");
  const old = ["2026-08-24", "2026-08-31", "2026-10-05"].map((d) => call(d, "09:00"));
  ok(discovery.findRepeatedWork(old, NOW, 3).length === 0, "a call older than the five-week window does not count");
  const six = [call("2026-09-07", "09:45"), ...["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"].map((d) => call(d, "09:00"))];
  ok(discovery.findRepeatedWork(six, new Date("2026-10-12T09:30:00.000Z"), 3).length === 1, "six same-weekday calls inside the window still make one pattern");
  const sixFound = discovery.findRepeatedWork(six, new Date("2026-10-12T09:30:00.000Z"), 3);
  ok(sixFound.length === 1 && sixFound[0]!.weeks === 5, "🔴 the count never exceeds five, so the card never says \"6 of the last 5 weeks\"");
  const two = [...mondayCalls(), ...["2026-09-23", "2026-09-30", "2026-10-07", "2026-09-16"].map((d) => call(d, "15:00", "notion", "search"))];
  const both = discovery.findRepeatedWork(two, NOW, 3);
  ok(both.length === 2 && both[0]!.fingerprint === "weekly:notion/search:3" && both[0]!.weeks === 4, "the strongest pattern comes first");
}

console.log("§2 the store read");
{
  const pg = new PGlite();
  const pgClient: PgClient = { query: (text, params) => pg.query(text, params ? [...params] : undefined) };
  await initOperationalSchema(pgClient);
  const engines = [
    ["sqlite", getOperationalStore()],
    ["postgres", makeOperationalPostgresStore(pgClient)],
  ] as const;
  const row = (over: Partial<ToolUsageEntry>): ToolUsageEntry => ({
    org: "store-org",
    ts: "2026-10-05T09:00:00.000Z",
    surfaceKey: "slack/T1/D-ALICE",
    principalId: "UALICE",
    sessionId: "s-dm",
    event: "call",
    tool: "list_issues",
    connector: "linear",
    outcome: "ok",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    ...over,
  });
  for (const [name, store] of engines) {
    await store.appendToolUsage(row({}));
    await store.appendToolUsage(row({ ts: "2026-10-05T09:01:00.000Z", sessionId: "s-routine" }));
    await store.appendUsageEvent({ org: "store-org", surfaceKey: "slack/T1/D-ALICE", sessionId: "s-routine", principalId: "UALICE", ts: "2026-10-05T09:01:00.000Z", kind: "routine", routineId: "r1", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    await store.appendUsageEvent({ org: "store-org", surfaceKey: "slack/T1/D-ALICE", sessionId: "s-dm", principalId: "UALICE", ts: "2026-10-05T09:00:00.000Z", kind: "dm", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    await store.appendToolUsage(row({ ts: "2026-10-05T09:02:00.000Z", principalId: "UBOB" }));
    await store.appendToolUsage(row({ ts: "2026-10-05T09:03:00.000Z", surfaceKey: "slack/T2/D-ALICE" }));
    await store.appendToolUsage(row({ ts: "2026-10-05T09:04:00.000Z", outcome: "error" }));
    await store.appendToolUsage(row({ ts: "2026-10-05T09:05:00.000Z", event: "card", outcome: "" }));
    await store.appendToolUsage(row({ ts: "2026-10-05T09:06:00.000Z", connector: "", tool: "remember" }));
    await store.appendToolUsage(row({ ts: "2026-08-01T09:00:00.000Z" }));
    await store.appendToolUsage(row({ ts: "2026-10-06T09:00:00.000Z", tool: "create_issue" }));
    const got = await store.listPersonConnectorCalls("store-org", "UALICE", "slack/T1/", "2026-05-11T23:30:00.000Z", 100);
    ok(got.length === 2 && got[0]!.tool === "list_issues" && got[1]!.tool === "create_issue", `${name}: only the person's own ok connector calls in the window, oldest first`);
    ok(!got.some((c) => c.ts === "2026-10-05T09:01:00.000Z"), `🔴 ${name}: a call made in a ROUTINE's session is left out — a routine's own runs are not the person repeating the work`);
    await store.appendToolUsage(row({ ts: "2026-10-05T10:00:00.000Z", surfaceKey: "discord/G1/C1", principalId: "D123", sessionId: "s-discord" }));
    const discordRows = await store.listPersonConnectorCalls("store-org", "D123", "discord/", "2026-05-11T23:30:00.000Z", 100);
    ok(discordRows.length === 1, `${name}: a Discord person's calls read under the bare platform prefix`);
    const capped = await store.listPersonConnectorCalls("store-org", "UALICE", "slack/T1/", "2026-05-11T23:30:00.000Z", 1);
    ok(capped.length === 1 && capped[0]!.tool === "create_issue", `${name}: the cap keeps the newest rows`);
  }
}

console.log("§3 the judgement");
{
  const fresh = state.freshWatchState(NOW.toISOString());
  const why = (s: Parameters<typeof discovery.judgeProposal>[0], at = NOW) => {
    const v = discovery.judgeProposal(s, at);
    return v.propose ? "propose" : v.reason;
  };
  ok(why(fresh) === "propose", "a fresh row on `less` may get a proposal");
  ok(why({ ...fresh, dial: "none" }) === "dial-none", "`none` never gets one");
  ok(why({ ...fresh, dampening: 1 }) === "dose-lowered", "a lowered dose holds it");
  ok(why(fresh, new Date("2026-10-12T21:00:00Z")) === "quiet-hours", "the quiet hours hold it");
  const nudged = { ...fresh, nudges: [{ fingerprint: "a", kind: "calendar-conflict", summary: "", at: "2026-10-12T07:30:00Z" }, { fingerprint: "b", kind: "calendar-conflict", summary: "", at: "2026-10-12T08:00:00Z" }] };
  ok(why(nudged) === "daily-budget", "two nudges today use up `less`'s daily limit, so a proposal waits");
  const recent = { ...fresh, proposals: [{ fingerprint: "x", summary: "", at: "2026-10-02T10:00:00Z" }] };
  ok(why(recent) === "proposal-gap", "`less` waits fourteen days between two proposals");
  ok(why({ ...recent, dial: "more" }) === "propose", "`more` waits seven");
}

console.log("§4 end to end");
interface PostedCard {
  readonly channel: string;
  readonly text: string;
  readonly buttons: readonly string[];
}
const cards: PostedCard[] = [];
let cardSeq = 0;
const slackPost = async (method: string, body: string): Promise<Record<string, unknown>> => {
  if (method === "chat.postMessage") {
    const form = new URLSearchParams(body);
    const blocks = JSON.parse(form.get("blocks") ?? "[]") as { type: string; elements?: { text?: { text?: string } }[] }[];
    const buttons = blocks.filter((b) => b.type === "actions").flatMap((b) => (b.elements ?? []).map((e) => e.text?.text ?? ""));
    cards.push({ channel: form.get("channel") ?? "", text: form.get("text") ?? "", buttons });
  }
  return { ok: true, ts: `1759836620.${String(++cardSeq).padStart(6, "0")}` };
};
const dmOf = (principalKey: string) => `D-${principalKey.split("/").at(-1)}`;
const resolveTarget = async (spec: { principalId?: string }) => {
  const dm = `D-${spec.principalId}`;
  return { ok: true as const, surfaceKey: `slack/T1/${dm}`, dispatch: { channel: {} as never, target: { channelId: dm }, mode: "dm" as const, attributes: {} } };
};
const propose = proposeRoutineCard({ resolveTarget: resolveTarget as never, post: slackPost });
const ledger = new Map<string, PersonConnectorCallRow[]>();
const reads: string[] = [];
const readCalls = async (_org: string, principalId: string) => {
  reads.push(principalId);
  return ledger.get(principalId) ?? [];
};
const deliver = async () => ({ ok: true as const, surfaceKey: "slack/T1/D" });
const tick = (now: Date, over: Partial<Parameters<typeof watch.personalWatchTick>[0]> = {}) => watch.personalWatchTick({ deliver, now, dmStopped: async () => false, propose, readCalls, ...over });
const due = (who: string) => state.updatePersonalWatch(ORG, who, (s) => { const { nextCheckAt: _n, lastDiscoveryAt: _d, ...rest } = s; return rest; });
const auditRows = async (action: string, principalId: string) => readAudit({ org: ORG, action, principalId });
const lastCardId = async (): Promise<string> => {
  const rows = await getOperationalStore().listPendingActions(ORG);
  return [...rows].filter((r) => r.kind === "routine.suggest" && r.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!.id;
};
const cardArgs = async (id: string) => JSON.parse((await getOperationalStore().getPendingAction(ORG, id))!.argsJson) as import("../agent/personal-watch/discovery.js").RoutineSuggestArgs;

const alice = "slack/T1/UALICE";
{
  ok(!watch.personalWatchArmed(), "no watch source is declared on this deployment");
  ledger.set("UALICE", mondayCalls());
  await state.enrollPersonalWatch(ORG, alice, NOW.toISOString());
  const r1 = await tick(NOW);
  ok(r1.checked === 1 && r1.proposed === 1, "🔴 with NO source declared, the tick checks the person and posts a proposal — today it does nothing at all");
  ok(reads.includes("UALICE"), "the read asks for the person's own native id");
  ok(cards.length === 1 && cards[0]!.channel === dmOf(alice), "ONE card, in the person's own DM");
  const card = cards[0]!;
  ok(card.buttons[0] === "Set it up" && card.buttons.at(-1) === "No thanks", "its buttons say Set it up and No thanks");
  ok(/Set up a routine to list issues on linear every Monday at 09:00 UTC\?/u.test(card.text), "the headline says what and when, in plain words");
  const visible = card.text.replace(/<@[^>]+>/gu, "");
  ok(!visible.includes("UALICE") && !visible.includes("weekly:") && !visible.includes("0 9 * * 1") && !visible.includes("D-UALICE"), "no raw person id, room id, fingerprint or cron reaches the card");
  const row = (await state.readPersonalWatch(ORG, alice)).state!;
  ok(row.proposals.length === 1 && row.proposals[0]!.fingerprint === "weekly:linear/list_issues:1" && row.proposals[0]!.outcome === undefined, "the row records the idea");
  ok(row.lastDiscoveryAt === NOW.toISOString(), "…and the scan time");
  const audit = await auditRows("personal_watch.proposal", alice);
  ok(audit.length === 1 && audit[0]!.detail?.["tool"] === "list_issues" && audit[0]!.detail?.["weekday"] === 1, "the post files one `personal_watch.proposal` row, ids only");

  const later = new Date("2026-10-26T10:00:00.000Z");
  ledger.set("UALICE", [...mondayCalls(), call("2026-10-12", "09:05"), call("2026-10-19", "09:05")]);
  await due(alice);
  const r2 = await tick(later);
  ok(r2.checked === 1 && r2.proposed === 0 && cards.length === 1, "🔴 the same idea is never offered twice");
  ledger.set("UALICE", [...mondayCalls(), call("2026-10-12", "09:05"), call("2026-10-19", "09:05"), ...["2026-10-07", "2026-10-14", "2026-10-21"].map((d) => call(d, "15:00", "notion", "search"))]);
  await due(alice);
  const r3 = await tick(later);
  const fps = (await state.readPersonalWatch(ORG, alice)).state!.proposals.map((p) => p.fingerprint);
  ok(r3.proposed === 1 && fps.join(",") === "weekly:linear/list_issues:1,weekly:notion/search:3", "🔴 an idea already offered does not block the next new one");
  ok(/search on notion every Wednesday at 15:00 UTC/u.test(cards.at(-1)!.text), "…and its card names the new work");
}

console.log("§5 Set it up");
{
  const rows = await getOperationalStore().listPendingActions(ORG);
  const cardId = rows.find((r) => r.kind === "routine.suggest" && r.status === "pending" && r.argsJson.includes("weekly:linear/list_issues:1") && r.argsJson.includes("UALICE"))!.id;
  const args = await cardArgs(cardId);
  const kind = actionKind("routine.suggest")!;
  ok(kind !== undefined && kind.policy === "member" && kind.sessionless === true, "the card kind is registered, member tier, sessionless");
  let refused = false;
  try {
    await kind.execute(args, "UMALLORY");
  } catch {
    refused = true;
  }
  ok(refused, "🔴 only the person the idea is for can press Set it up");
  ok((await getOperationalStore().listRoutines(ORG, args.create.surfaceKey)).length === 0, "…and the refused press armed nothing");
  const line = await kind.execute(args, "UALICE");
  ok(/routine started, runs every Monday at 09:00 UTC/u.test(line), "the press answers in plain words");
  const routines = await getOperationalStore().listRoutines(ORG, args.create.surfaceKey);
  ok(routines.length === 1, "🔴 Set it up creates the routine");
  const r = routines[0]!;
  ok(r.surfaceKey === "slack/T1/D-UALICE" && r.trigger.kind === "cron" && r.trigger.expr === "0 9 * * 1", "in the person's DM, on the usual day and hour");
  ok(r.createdBy === "UALICE" && r.status === "active" && r.taintedAtCreation === undefined, "created by the person, active, and not tainted");
  ok(r.prompt === discovery.proposalPrompt({ connector: "linear", tool: "list_issues", weekday: 1 }), "with the host-written instruction the card showed");
  const createRows = (await readAudit({ org: ORG, action: "routine.create" })).filter((a) => a.detail?.["id"] === r.id);
  ok(createRows.length === 1 && createRows[0]!.principalId === "UALICE", "🔴 through the normal routine path: one `routine.create` row, armed by the person");
  ok((await state.readPersonalWatch(ORG, alice)).state!.proposals[0]!.outcome === "accepted", "the row records Set it up");
  ok((await auditRows("personal_watch.proposal.accepted", alice)).length === 1, "…and files `personal_watch.proposal.accepted`");
}

console.log("§6 No thanks");
{
  const bob = "slack/T1/UBOB";
  ledger.set("UBOB", mondayCalls());
  await state.enrollPersonalWatch(ORG, bob, NOW.toISOString());
  const before = cards.length;
  await tick(NOW);
  ok(cards.length === before + 1 && cards.at(-1)!.channel === "D-UBOB", "Bob gets his own proposal");
  const args = await cardArgs(await lastCardId());
  const kind = actionKind("routine.suggest")!;
  const line = await kind.declined!(args, "UBOB");
  ok(line === "I won't suggest this again", "No thanks says what it recorded");
  const row = (await state.readPersonalWatch(ORG, bob)).state!;
  ok(row.proposals[0]!.outcome === "declined" && typeof row.proposals[0]!.decidedAt === "string", "🔴 the decline is remembered on the person's row");
  ok((await auditRows("personal_watch.proposal.declined", bob)).length === 1, "…and files `personal_watch.proposal.declined`");
  ok((await getOperationalStore().listRoutines(ORG, args.create.surfaceKey)).length === 0, "No thanks arms nothing");
  ledger.set("UBOB", ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"].map((d) => call(d, "09:00")));
  await due(bob);
  const r = await tick(new Date("2026-11-09T10:00:00.000Z"));
  ok(r.proposed === 0 && cards.length === before + 1, "🔴 a declined idea is never offered again");
  ok((await state.recordProposalOutcome(ORG, bob, "weekly:linear/list_issues:1", "accepted")) === "unchanged", "the first answer stands");
  ok((await state.recordProposalOutcome(ORG, bob, "weekly:nothing:9", "declined")) === "unknown", "a forged fingerprint changes nothing");
}

console.log("§7 off switches and failures");
{
  const carol = "slack/T1/UCAROL";
  ledger.set("UCAROL", mondayCalls());
  await state.enrollPersonalWatch(ORG, carol, NOW.toISOString());
  await state.setPersonalWatchDial({ org: ORG, platform: "slack", workspace: "T1", surface: "home", principalKey: carol }, "none", "command");
  reads.length = 0;
  await tick(NOW);
  ok(!reads.includes("UCAROL"), "`none` does not even read the ledger");

  const dan = "slack/T1/UDAN";
  ledger.set("UDAN", mondayCalls());
  await state.enrollPersonalWatch(ORG, dan, NOW.toISOString());
  overrideSettingsForTest({ routines: { discoveryMinWeeks: 0 } });
  reads.length = 0;
  const off = await tick(NOW);
  ok(!discovery.discoveryOn() && off.checked === 0 && reads.length === 0, "`discoveryMinWeeks: 0` turns it off: with no source either, the tick does nothing");
  overrideSettingsForTest({ routines: { discoveryMinWeeks: 3 } });

  const before = cards.length;
  const refused = await tick(NOW, { propose: async () => ({ ok: false, reason: "no DM" }) });
  ok(refused.proposed === 0 && cards.length === before, "a refused post sends nothing");
  ok((await state.readPersonalWatch(ORG, dan)).state!.proposals.length === 0, "…and takes the idea back, so a later scan offers it");
  const rows = await auditRows("personal_watch.silence", dan);
  ok(rows.length === 1 && rows[0]!.detail?.["reason"] === "delivery-refused" && rows[0]!.detail?.["kind"] === "repeated-work", "…and files one `delivery-refused` silence row");
  await due(dan);
  await tick(new Date("2026-10-12T11:00:00.000Z"));
  ok(cards.length === before + 1 && cards.at(-1)!.channel === "D-UDAN", "the next scan offers it");

  const erin = "slack/T1/UERIN";
  ledger.set("UERIN", mondayCalls());
  await state.enrollPersonalWatch(ORG, erin, NOW.toISOString());
  const quiet = await tick(new Date("2026-10-12T21:00:00.000Z"));
  ok(quiet.proposed === 0, "nothing is proposed at 21:00 UTC");
  const held = await auditRows("personal_watch.silence", erin);
  ok(held.length === 1 && held[0]!.detail?.["reason"] === "quiet-hours" && !JSON.stringify(held[0]!.detail).includes("UERIN"), "the hold files one `quiet-hours` row");

  const gus = "slack/T1/UGUS";
  ledger.set("UGUS", mondayCalls());
  await state.enrollPersonalWatch(ORG, gus, NOW.toISOString());
  const beforeGus = cards.length;
  await tick(NOW, { dmStopped: async (_o: string, key: string) => key === gus });
  ok(cards.length === beforeGus && (await state.readPersonalWatch(ORG, gus)).state!.proposals.length === 0, "🔴 a person who stopped proactive DMs gets no proposal card");
  const stopped = await auditRows("personal_watch.silence", gus);
  ok(stopped.length === 1 && stopped[0]!.detail?.["reason"] === "dm-stopped", "…and the hold files one `dm-stopped` row");

  const dora = "discord/DORA1";
  for (const d of MONDAYS) {
    await getOperationalStore().appendToolUsage({ org: ORG, ts: `${d}T09:00:00.000Z`, surfaceKey: "discord/G1/C9", principalId: "DORA1", sessionId: `s-dora-${d}`, event: "call", tool: "list_issues", connector: "linear", outcome: "ok", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  }
  await state.enrollPersonalWatch(ORG, dora, NOW.toISOString());
  const offered: string[] = [];
  await watch.personalWatchTick({ deliver, now: NOW, dmStopped: async () => false, propose: async ({ principalKey, work }) => (offered.push(`${principalKey} ${work.fingerprint}`), { ok: true, cardId: "c-dora" }) });
  ok(offered.includes("discord/DORA1 weekly:linear/list_issues:1"), "🔴 a Discord person's repeated work is found through the live store read");

  const fay = "slack/T1/UFAY";
  ledger.set("UFAY", mondayCalls());
  await state.enrollPersonalWatch(ORG, fay, NOW.toISOString());
  reads.length = 0;
  await watch.personalWatchTick({ deliver, now: NOW, dmStopped: async () => false, readCalls });
  ok(reads.length === 0, "with no proposal edge, the tick runs no discovery");
}

console.log("§8 repeated questions");
{
  const q = questions.questionOf("<@U0BOT> Who is on call this week?");
  ok(q !== undefined && q.words === "who is on call this week?" && /^[0-9a-f]{16}$/u.test(q.fingerprint), "a one-line question is normalized: the mention and the case go, the `?` stays");
  ok(questions.questionOf("who is ON CALL this week ?")?.fingerprint === q!.fingerprint, "the same words in another case and spacing are the same question");
  ok(questions.questionOf("Who is on call next week?")?.fingerprint !== q!.fingerprint, "other words are another question");
  ok(questions.questionOf("Please list the open incidents") === undefined, "a request with no `?` is not a question");
  ok(questions.questionOf("what is this https://example.com/x?") === undefined, "a question with a link is not recorded");
  ok(questions.questionOf("why?") === undefined && questions.questionOf("hi there\nwhat is up?") === undefined, "a one-word question and a two-line message are not recorded");
  ok(questions.questionOf(`${"word ".repeat(30)}?`) === undefined, "a long message is not recorded");

  const env = (reason: string, addressing: string, author: string, body: string) =>
    `<wake reason="${reason}" addressing="${addressing}" wake-id="w1">\n  <channel id="C1">\n    <message from="human" author-id="${author}" trigger="true">\n      ${body}\n    </message>\n  </channel>\n</wake>`;
  ok(questions.askedText(env("mention", "direct-mention", "UALICE", "who is on call?"), "channel", "UALICE") === "who is on call?", "an @mention in a room is the person's own ask");
  ok(questions.askedText(env("channel-activity", "channel-watch", "UALICE", "who is on call?"), "channel", "UALICE") === undefined, "🔴 a room message that does not address the agent is never recorded");
  ok(questions.askedText(env("dm", "direct", "UMALLORY", "who is on call?"), "dm", "UALICE") === undefined, "a trigger by somebody else is not the acting person's ask");
  ok(questions.askedText("who is on call?", "dm", "UALICE") === "who is on call?" && questions.askedText("who is on call?", "channel", "UALICE") === undefined, "a bare string is the person's own words only in a DM");

  const entry = (who: string, ts: string, mode: "dm" | "channel" = "dm", surface = `D-${who}`, text = "who is on call this week?") =>
    questions.questionEntry({ org: ORG, ts, surfaceKey: `slack/T1/${surface}`, mode, principalId: who, question: questions.questionOf(text)! });
  const store = getOperationalStore();
  ledgerHook.holdQuestion("s1", "t1", entry("UHAL", "2026-10-05T09:00:00.000Z"));
  ledgerHook.noteToolResult("s1", "t1", { kind: "tool-result", toolName: "remember" });
  ok((await ledgerHook.settleQuestion("s1", "t1", true)) === "written", "a question answered with no connector call is written");
  ledgerHook.holdQuestion("s2", "t2", entry("UHAL", "2026-10-05T09:05:00.000Z"));
  ledgerHook.noteToolResult("s2", "t2", { kind: "tool-result", toolName: "linear__list_issues" });
  ok((await ledgerHook.settleQuestion("s2", "t2", true)) === "none", "🔴 a question the turn answered with a connector op is NOT written — the tool-call ledger already holds that work");
  ledgerHook.holdQuestion("s3", "t3", entry("UHAL", "2026-10-05T09:06:00.000Z"));
  ok((await ledgerHook.settleQuestion("s3", "t3", false)) === "none", "a failed or cancelled turn writes nothing");
  const halRows = await store.listPersonQuestions(ORG, "UHAL", "slack/T1/", "2026-05-05T23:30:00.000Z", 100);
  ok(halRows.length === 1 && halRows[0]!.words === "who is on call this week?", "the ledger holds the one answered question");
  await setPersonOptOut({ org: ORG, platform: "slack", workspace: "T1", surface: "D-UIVY", principalKey: "slack/T1/UIVY" }, "command");
  ok((await ledgerHook.writeQuestion(entry("UIVY", "2026-10-05T09:00:00.000Z"))) === "opted-out", "🔴 a person who opted out of the agent remembering their content is never recorded");
  ok((await store.listPersonQuestions(ORG, "UIVY", "slack/T1/", "2026-05-05T23:30:00.000Z", 100)).length === 0, "…and the ledger holds nothing for them");

  const pg = new PGlite();
  const pgClient: PgClient = { query: (text, params) => pg.query(text, params ? [...params] : undefined) };
  await initOperationalSchema(pgClient);
  for (const [name, eng] of [["sqlite", store], ["postgres", makeOperationalPostgresStore(pgClient)]] as const) {
    const o = "q-org";
    const at = (ts: string, who: string, mode: "dm" | "channel", surface: string) => eng.appendQuestion({ ...entry(who, ts, mode, surface), org: o }, questions.questionPruneBefore(ts));
    await at("2026-08-01T09:00:00.000Z", "UANN", "dm", "D-UANN");
    await at("2026-10-05T09:00:00.000Z", "UANN", "dm", "D-UANN");
    await at("2026-10-05T09:01:00.000Z", "UANN", "channel", "C-OPS");
    await at("2026-10-05T09:02:00.000Z", "UBEN", "channel", "C-OPS");
    const mine = await eng.listPersonQuestions(o, "UANN", "slack/T1/", "2026-07-01T00:00:00.000Z", 100);
    ok(mine.length === 1 && mine[0]!.surfaceKey === "slack/T1/D-UANN", `🔴 ${name}: the person's read holds their own DM questions only, and the keep deleted the row older than ${questions.QUESTION_LEDGER_KEEP_DAYS} days`);
    const room = await eng.listRoomQuestions(o, "2026-07-01T00:00:00.000Z", 100);
    ok(room.length === 2 && room.every((r) => r.surfaceKey === "slack/T1/C-OPS") && room[0]!.principalId === "UANN" && room[1]!.principalId === "UBEN", `${name}: the room read holds the room's questions, oldest first, with who asked`);
    const tu = (over: Partial<ToolUsageEntry>): ToolUsageEntry => ({ org: o, ts: "2026-10-05T09:00:00.000Z", surfaceKey: "slack/T1/C-OPS", surfaceMode: "channel", principalId: "UANN", sessionId: "s-room", event: "call", tool: "list_issues", connector: "linear", outcome: "ok", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, ...over });
    await eng.appendToolUsage(tu({}));
    await eng.appendToolUsage(tu({ ts: "2026-10-05T09:01:00.000Z", surfaceKey: "slack/T1/D-UANN", surfaceMode: "dm" }));
    await eng.appendToolUsage(tu({ ts: "2026-10-05T09:02:00.000Z", sessionId: "s-room-routine" }));
    await eng.appendUsageEvent({ org: o, surfaceKey: "slack/T1/C-OPS", sessionId: "s-room-routine", principalId: "UANN", ts: "2026-10-05T09:02:00.000Z", kind: "routine", routineId: "r9", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    await eng.appendToolUsage(tu({ ts: "2026-10-05T09:03:00.000Z", outcome: "error" }));
    const roomCalls = await eng.listRoomConnectorCalls(o, "2026-05-05T23:30:00.000Z", 100);
    ok(roomCalls.length === 1 && roomCalls[0]!.surfaceKey === "slack/T1/C-OPS" && roomCalls[0]!.principalId === "UANN", `🔴 ${name}: the room read holds ok connector calls in rooms only, and never a routine's run`);
  }

  const qrows = (who: string, dates: readonly string[], text = "who is on call this week?"): QuestionLedgerRow[] =>
    dates.map((d) => ({ ts: `${d}T16:00:00.000Z`, surfaceKey: `slack/T1/D-${who}`, principalId: who, ...questions.questionOf(text)! }));
  const FRIDAYS = ["2026-09-25", "2026-10-03", "2026-10-09"];
  const found = discovery.findRepeatedQuestions(qrows("UJO", FRIDAYS), NOW, 3);
  ok(found.length === 1 && found[0]!.question === "who is on call this week?" && found[0]!.weekday === 5 && found[0]!.fingerprint.startsWith("weekly:q:"), "the same question three Fridays in a row is one pattern");
  ok(discovery.findRepeatedQuestions(qrows("UJO", FRIDAYS.slice(1)), NOW, 3).length === 0, "two Fridays are not enough");
  const w = found[0]!;
  ok(discovery.repeatedWorkWords(w) === 'answer "who is on call this week?"', "the card names the question in plain words");
  ok(!discovery.repeatedWorkSummary(w).includes("on call"), "🔴 the summary, which reaches the silence row, carries no question words");
  ok(discovery.proposalPrompt(w).includes('"who is on call this week?"') && discovery.proposalPrompt(w).includes("Ask before you change anything"), "the routine instruction quotes the question and asks before any change");

  const jo = "slack/T1/UJO";
  const qLedger = new Map<string, QuestionLedgerRow[]>([["UJO", qrows("UJO", FRIDAYS)]]);
  const readQuestions = async (_o: string, principalId: string) => qLedger.get(principalId) ?? [];
  await state.enrollPersonalWatch(ORG, jo, NOW.toISOString());
  const before = cards.length;
  const r = await tick(NOW, { readQuestions });
  const joCards = cards.slice(before).filter((c) => c.channel === "D-UJO");
  ok(r.proposed >= 1 && joCards.length === 1, "🔴 a question asked every Friday with no connector call gets ONE card in the person's DM — today it is never found");
  ok(/Set up a routine to answer .who is on call this week\?. every Friday at 16:00 UTC\?/u.test(joCards[0]!.text), "the headline says which question and when");
  const visible = joCards[0]!.text.replace(/<@[^>]+>/gu, "");
  ok(!visible.includes("UJO") && !visible.includes("weekly:") && !visible.includes(w.fingerprint.split(":")[2]!), "no raw id, fingerprint or hash reaches the card");
  const proposalRows = await auditRows("personal_watch.proposal", jo);
  ok(proposalRows.length === 1 && proposalRows[0]!.detail?.["kind"] === "question" && !JSON.stringify(proposalRows[0]!.detail).includes("on call"), "the proposal row says it is a question, by hash, with no words");
  const joId = (await getOperationalStore().listPendingActions(ORG)).find((p) => p.kind === "routine.suggest" && p.status === "pending" && p.argsJson.includes("UJO"))!.id;
  const args = await cardArgs(joId);
  const line = await actionKind("routine.suggest")!.execute(args, "UJO");
  const routines = await getOperationalStore().listRoutines(ORG, args.create.surfaceKey);
  ok(/routine started/u.test(line) && routines.length === 1 && routines[0]!.prompt.includes('"who is on call this week?"') && routines[0]!.createdBy === "UJO", "Set it up arms a routine that answers the question, created by the person");
  qLedger.set("UJO", qrows("UJO", [...FRIDAYS, "2026-10-16"]));
  await due(jo);
  const again = await tick(new Date("2026-10-30T10:00:00.000Z"), { readQuestions });
  ok(again.proposed === 0, "🔴 a question already offered is never offered again");

  const lee = "slack/T1/ULEE";
  qLedger.set("ULEE", qrows("ULEE", FRIDAYS));
  await state.enrollPersonalWatch(ORG, lee, NOW.toISOString());
  await setPersonOptOut({ org: ORG, platform: "slack", workspace: "T1", surface: "D-ULEE", principalKey: lee }, "command");
  const beforeLee = cards.length;
  await tick(NOW, { readQuestions });
  ok(!cards.slice(beforeLee).some((c) => c.channel === "D-ULEE"), "🔴 an opt-out drops the person's recorded questions at read time: no card quotes their words");

  const kim = "slack/T1/UKIM";
  qLedger.set("UKIM", qrows("UKIM", FRIDAYS));
  await state.enrollPersonalWatch(ORG, kim, NOW.toISOString());
  const beforeKim = cards.length;
  await tick(NOW, { readQuestions, dmStopped: async (_o: string, key: string) => key === kim });
  ok(cards.length === beforeKim && (await auditRows("personal_watch.silence", kim))[0]?.detail?.["reason"] === "dm-stopped", "🔴 a person who stopped proactive DMs gets no question card, and the hold is filed");
}

console.log("§9 shared rooms");
{
  const ROOM = "slack/T1/C-OPS";
  const roomCall = (date: string, who: string, surfaceKey = ROOM): RoomConnectorCallRow => ({ ts: `${date}T09:00:00.000Z`, surfaceKey, principalId: who, connector: "pagerduty", tool: "list_incidents" });
  const shared = [roomCall(MONDAYS[0]!, "UANN"), roomCall(MONDAYS[1]!, "UBEN"), roomCall(MONDAYS[2]!, "UANN")];
  const solo = [roomCall(MONDAYS[0]!, "UANN"), roomCall(MONDAYS[1]!, "UANN"), roomCall(MONDAYS[2]!, "UANN")];
  const found = roomDiscovery.findRoomPatterns(shared, [], NOW, 3);
  ok(found.get(ROOM)?.length === 1 && found.get(ROOM)![0]!.fingerprint === "weekly:pagerduty/list_incidents:1" && found.get(ROOM)![0]!.people === 2, "the same op by two people on three Mondays is one room pattern");
  ok(roomDiscovery.findRoomPatterns(solo, [], NOW, 3).size === 0, "🔴 one person's own habit is not a room pattern — that person's DM gets it instead");
  const soloPlusOne = [...solo, { ...roomCall(MONDAYS[1]!, "UBEN"), ts: `${MONDAYS[1]}T09:30:00.000Z` }];
  ok(roomDiscovery.findRoomPatterns(soloPlusOne, [], NOW, 3).size === 0, "🔴 an op one person repeats alone stays theirs, even when a second person joins once — one habit never gets two cards");
  const askers = MONDAYS.map((d, i) => ({ ts: `${d}T10:00:00.000Z`, surfaceKey: ROOM, principalId: i === 1 ? "UBEN" : "UANN", ...questions.questionOf("what shipped last week?")! }));
  const kept = await roomDiscovery.withoutOptedOut(ORG, askers, async (_o, key) => key === "slack/T1/UBEN");
  ok(kept.length === 2 && kept.every((r) => r.principalId === "UANN") && roomDiscovery.findRoomPatterns([], kept, NOW, 3).size === 0, "🔴 an opted-out asker's questions are dropped at read time, so the room pattern falls below two people");
  ok((await roomDiscovery.withoutOptedOut(ORG, askers, async () => { throw new Error("store down"); })).length === 0, "an unreadable opt-out drops the rows (fail-closed)");
  const split = [roomCall(MONDAYS[0]!, "UANN"), roomCall(MONDAYS[1]!, "UBEN", "slack/T1/C-OTHER"), roomCall(MONDAYS[2]!, "UANN")];
  ok(roomDiscovery.findRoomPatterns(split, [], NOW, 3).size === 0, "calls in two rooms do not add up to one room's pattern");
  const roomQs: QuestionLedgerRow[] = MONDAYS.map((d, i) => ({ ts: `${d}T10:00:00.000Z`, surfaceKey: ROOM, principalId: i === 1 ? "UBEN" : "UANN", ...questions.questionOf("what shipped last week?")! }));
  const qFound = roomDiscovery.findRoomPatterns([], roomQs, NOW, 3).get(ROOM);
  ok(qFound?.length === 1 && qFound[0]!.question === "what shipped last week?", "a question two people ask the agent in the room on three Mondays is a room pattern");

  const roomCards: PostedCard[] = [];
  const roomPost = async (method: string, body: string) => {
    const res = await slackPost(method, body);
    if (method === "chat.postMessage") roomCards.push(cards.pop()!);
    return res;
  };
  const resolveRoom = async (spec: { kind: string; surface?: string }) =>
    spec.kind === "room"
      ? { ok: true as const, surfaceKey: `slack/T1/${spec.surface}`, dispatch: { channel: {} as never, target: { channelId: spec.surface }, mode: "channel" as const, attributes: {} } }
      : { ok: false as const, reason: "not a room" };
  const memberFloor = async () => ({ floor: "member" as const, roster: { humanMemberIds: ["UANN", "UBEN"], resolved: true } });
  const proposeRoom = proposeRoomRoutineCard({ resolveTarget: resolveRoom as never, post: roomPost, floor: memberFloor as never });
  let roomCalls: RoomConnectorCallRow[] = shared;
  let roomQuestions: QuestionLedgerRow[] = [];
  const roomTick = (now: Date, over: Partial<Parameters<typeof watch.personalWatchTick>[0]> = {}) =>
    watch.personalWatchTick({ deliver, now, dmStopped: async () => false, proposeRoom, readRoomCalls: async () => roomCalls, readRoomQuestions: async () => roomQuestions, ...over });
  const r1 = await roomTick(NOW);
  ok(r1.roomProposed === 1 && roomCards.length === 1 && roomCards[0]!.channel === "C-OPS", "🔴 the tick posts ONE card into the room itself — today a room's shared pattern is never found");
  const card = roomCards[0]!;
  ok(card.buttons[0] === "Set it up" && card.buttons.at(-1) === "No thanks", "its buttons say Set it up and No thanks");
  ok(/Set up a routine to list incidents on pagerduty every Monday at 09:00 UTC\?/u.test(card.text), "the headline says what and when, in plain words");
  ok(!card.text.replace(/<@[^>]+>/gu, "").match(/UANN|UBEN|C-OPS|weekly:|oe:room-discovery/u), "no person id, room id, fingerprint or host requester reaches the card");
  const row = (await getOperationalStore().getRoomWatch(ORG, ROOM))!;
  ok(JSON.parse(row.stateJson).proposals[0].fingerprint === "weekly:pagerduty/list_incidents:1" && !row.stateJson.includes("UANN"), "the room's row records the idea, with no person id");
  const proposed = await readAudit({ org: ORG, action: "room_watch.proposal" });
  ok(proposed.length === 1 && proposed[0]!.detail?.["people"] === 2 && proposed[0]!.surface === "C-OPS", "the post files one `room_watch.proposal` row");

  let roomReads = 0;
  const r2 = await roomTick(new Date("2026-10-12T12:00:00.000Z"), { readRoomCalls: async () => (roomReads++, roomCalls) });
  ok(r2.roomProposed === 0 && roomCards.length === 1 && roomReads === 0, "🔴 the org's rooms are scanned at most once a day: a second tick that day reads no ledger");

  const rows = await getOperationalStore().listPendingActions(ORG);
  const cardId = rows.find((r) => r.kind === "routine.suggest" && r.status === "pending" && r.argsJson.includes('"scope":"room"'))!.id;
  const args = JSON.parse((await getOperationalStore().getPendingAction(ORG, cardId))!.argsJson) as import("../agent/personal-watch/room-discovery.js").RoomRoutineSuggestArgs;
  ok(args.scope === "room" && args.create.surfaceKey === ROOM && (args.create as { createdBy?: string }).createdBy === undefined, "the card freezes the room's routine, with no creator until a member presses");
  const line = await actionKind("routine.suggest")!.execute(args, "UCARL");
  const routines = await getOperationalStore().listRoutines(ORG, ROOM);
  ok(/routine started, runs every Monday at 09:00 UTC/u.test(line) && routines.length === 1, "🔴 Set it up arms the routine in the room");
  ok(routines[0]!.createdBy === "UCARL" && routines[0]!.trigger.kind === "cron" && routines[0]!.prompt.startsWith("It is Monday. The people in this room"), "created by the member who pressed, with the room's host-written instruction");
  ok(JSON.parse((await getOperationalStore().getRoomWatch(ORG, ROOM))!.stateJson).proposals[0].outcome === "accepted", "the room's row records Set it up");
  ok((await readAudit({ org: ORG, action: "room_watch.proposal.accepted" }))[0]?.principalId === "UCARL", "…and files `room_watch.proposal.accepted` naming who pressed");

  const QA = "slack/T1/C-QA";
  roomCalls = [];
  roomQuestions = MONDAYS.map((d, i) => ({ ts: `${d}T10:00:00.000Z`, surfaceKey: QA, principalId: i === 1 ? "UBEN" : "UANN", ...questions.questionOf("what shipped last week?")! }));
  await roomTick(new Date("2026-10-13T10:00:00.000Z"));
  ok(roomCards.length === 2 && roomCards[1]!.channel === "C-QA" && /answer .what shipped last week\?./u.test(roomCards[1]!.text), "a question the room keeps asking gets its own card in that room");
  const qaId = (await getOperationalStore().listPendingActions(ORG)).find((r) => r.kind === "routine.suggest" && r.status === "pending" && r.argsJson.includes("C-QA"))!.id;
  const qaArgs = JSON.parse((await getOperationalStore().getPendingAction(ORG, qaId))!.argsJson) as import("../agent/personal-watch/room-discovery.js").RoomRoutineSuggestArgs;
  ok((await actionKind("routine.suggest")!.declined!(qaArgs, "UANN")) === "I won't suggest this here again", "No thanks says what it recorded");
  ok(JSON.parse((await getOperationalStore().getRoomWatch(ORG, QA))!.stateJson).proposals[0].outcome === "declined", "🔴 the decline is remembered on the room's row");
  ok((await readAudit({ org: ORG, action: "room_watch.proposal.declined" })).length === 1, "…and files `room_watch.proposal.declined`");
  ok((await getOperationalStore().listRoutines(ORG, QA)).length === 0, "No thanks arms nothing");
  roomQuestions = [...roomQuestions, ...["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"].map((d, i) => ({ ts: `${d}T10:00:00.000Z`, surfaceKey: QA, principalId: i % 2 ? "UBEN" : "UANN", ...questions.questionOf("what shipped last week?")! }))];
  await roomTick(new Date("2026-11-03T10:00:00.000Z"));
  ok(roomCards.length === 2, "🔴 a declined idea is never offered to that room again, a month later");

  roomCalls = [...shared, ...["2026-10-28", "2026-11-04", "2026-11-11"].map((d, i) => ({ ts: `${d}T15:00:00.000Z`, surfaceKey: ROOM, principalId: i === 1 ? "UBEN" : "UANN", connector: "linear", tool: "list_issues" }))];
  roomQuestions = [];
  await roomDiscovery.updateRoomWatch(ORG, ROOM, (cur) => ({ ...cur, proposals: cur.proposals.map((p) => ({ ...p, at: "2026-11-05T10:00:00.000Z" })) }));
  await roomTick(new Date("2026-11-12T10:00:00.000Z"));
  ok(roomCards.length === 2, "🔴 a room gets at most one card per fourteen days");
  await roomTick(new Date("2026-11-20T10:00:00.000Z"));
  ok(roomCards.length === 3 && /list issues on linear every Wednesday/u.test(roomCards[2]!.text), "…and the next new idea is offered after the gap");

  const REFUSED = "slack/T1/C-REFUSED";
  roomCalls = MONDAYS.map((d, i) => roomCall(d, i === 1 ? "UBEN" : "UANN", REFUSED));
  await roomDiscovery.updateRoomWatch(ORG, roomDiscovery.ROOM_SCAN_KEY, (cur) => ({ proposals: cur.proposals }));
  const refused = await roomTick(NOW, { proposeRoom: async () => ({ ok: false, reason: "no card path" }) });
  ok(refused.roomProposed === 0 && JSON.parse((await getOperationalStore().getRoomWatch(ORG, REFUSED))!.stateJson).proposals.length === 0, "a refused room post takes the idea back, so a later scan offers it");

  const viaDm = proposeRoomRoutineCard({ resolveTarget: (async () => ({ ok: true, surfaceKey: "slack/T1/D-X", dispatch: { channel: {} as never, target: { channelId: "D-X" }, mode: "dm", attributes: {} } })) as never, post: roomPost });
  const viaDmResult = await viaDm({ org: ORG, surfaceKey: ROOM, work: found.get(ROOM)![0]! });
  ok(!viaDmResult.ok && /not a shared room/u.test(viaDmResult.reason), "🔴 a room card that would land in a DM is refused");

  const GUEST = "slack/T1/C-GUEST";
  roomCalls = MONDAYS.map((d, i) => roomCall(d, i === 1 ? "UBEN" : "UANN", GUEST));
  roomQuestions = [];
  await roomDiscovery.updateRoomWatch(ORG, roomDiscovery.ROOM_SCAN_KEY, (cur) => ({ proposals: cur.proposals }));
  const guestFloor = async () => ({ floor: "guest" as const, roster: { humanMemberIds: ["UANN", "UGUEST"], resolved: true } });
  const beforeGuest = roomCards.length;
  const guestTick = await roomTick(NOW, { proposeRoom: proposeRoomRoutineCard({ resolveTarget: resolveRoom as never, post: roomPost, floor: guestFloor as never }) });
  ok(guestTick.roomProposed === 0 && roomCards.length === beforeGuest, "🔴 a room that holds a guest gets no card — the clicker floor would refuse every press");
  ok(JSON.parse((await getOperationalStore().getRoomWatch(ORG, GUEST))!.stateJson).proposals.length === 1, "…and the idea stays reserved, so the next scan does not post and refuse it again");

  overrideSettingsForTest({ routines: { discoveryMinWeeks: 0 } });
  await roomDiscovery.updateRoomWatch(ORG, roomDiscovery.ROOM_SCAN_KEY, (cur) => ({ proposals: cur.proposals }));
  let read = false;
  await roomTick(NOW, { readRoomCalls: async () => ((read = true), []) });
  ok(!read, "`discoveryMinWeeks: 0` reads no room ledger");
  overrideSettingsForTest({ routines: { discoveryMinWeeks: 3 } });
}

removeTempDir(tmp);
console.log(`✓ workflow discovery: ${n} assertions`);
process.exit(0);
