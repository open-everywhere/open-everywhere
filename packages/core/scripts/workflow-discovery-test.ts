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
const { proposeRoutineCard } = await import("../agent/personal-watch/propose.js");
await import("../agent/approvals/flow.js");
const { actionKind } = await import("../agent/approvals/actions.js");
type PersonConnectorCallRow = import("../agent/operational/store.js").PersonConnectorCallRow;
type ToolUsageEntry = import("../agent/operational/store.js").ToolUsageEntry;
type PgClient = import("../agent/operational/postgres.js").PgClient;

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

removeTempDir(tmp);
console.log(`✓ workflow discovery: ${n} assertions`);
process.exit(0);
