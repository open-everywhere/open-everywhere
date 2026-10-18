import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-ask-watch-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_MEMORY_DIR = join(tmp, "memory");
delete process.env.DATABASE_URL;
delete process.env.OE_MEMORY_PROVIDER;

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

await import("../agent/routines/github-normalizer.js");
await import("../agent/webhooks/oe-standard-webhook.js");
const aw = await import("../agent/routines/ask-watch.js");
const { registerEventReach, eventReach } = await import("../agent/routines/event-reach.js");
let githubReach: boolean | "throw" = false;
const { triggerWords, sourceWords } = await import("../agent/routines/schedule-words.js");
const { registeredEventSources } = await import("../agent/routines/event-model.js");
const { renderScopeMarkdown } = await import("../agent/instructions/access.js");
const { classifySessionId, taskWindowId } = await import("../agent/channels/window-key.js");
await import("../agent/approvals/flow.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { consequenceForRow } = await import("../agent/approvals/plain-summary.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { listAllRoutines } = await import("../agent/routines/store.js");
const { doingForPerson } = await import("../agent/status/doing-for-me.js");
type SurfaceBinding = import("../agent/identity/binding.js").SurfaceBinding;
type RoutineCreateArgs = import("../agent/approvals/routine-create.js").RoutineCreateArgs;
type Routine = import("../agent/routines/routine.js").Routine;

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    removeTempDir(tmp);
    process.exit(1);
  }
  n++;
}
async function refuses(fn: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    ok(msg.includes(needle), `${label} (got: ${msg.slice(0, 200)})`);
    return;
  }
  ok(false, `${label} (it did not refuse)`);
}

const ORG = "default";
const ID_LIKE = /\b(?:[UCDTG][A-Z0-9]{6,}|r-[0-9a-f]{6,})\b/u;
const dmOf = (person: string, dm: string): SurfaceBinding =>
  ({ org: ORG, platform: "slack", workspace: "T1", surface: dm, mode: "dm", visibility: "private", trust: "internal", principalId: person }) as SurfaceBinding;
const roomOf = (person: string, room: string): SurfaceBinding =>
  ({ org: ORG, platform: "slack", workspace: "T1", surface: room, mode: "channel", visibility: "public", trust: "internal", principalId: person }) as SurfaceBinding;

console.log("§1 the words");
{
  ok(sourceWords("github") === "GitHub", "github reads GitHub");
  ok(sourceWords("linear") === "Linear" && sourceWords("my-ci") === "My Ci", "any other source reads with capitals");
  ok(triggerWords({ kind: "event", source: "github" }) === "when GitHub sends an event", "🔴 an event trigger names the app by its friendly name");
  ok(aw.cleanWatchFor("  a new issue is   opened in acme/web.  ") === "a new issue is opened in acme/web", "the condition is trimmed to one line");
  ok(aw.cleanWatchFor("   ") === undefined && aw.cleanWatchFor(undefined) === undefined, "a blank condition is no condition");
  let threw = false;
  try {
    aw.cleanWatchFor("x".repeat(aw.WATCH_FOR_MAX_CHARS + 1));
  } catch {
    threw = true;
  }
  ok(threw, "a condition over the limit is refused, not cut");
  ok(aw.watchWords({ kind: "event", source: "github" }, "a new issue is opened in acme/web") === "watches GitHub for when a new issue is opened in acme/web", "🔴 an event watch reads as its app and its condition");
  ok(aw.watchWords({ kind: "watch", everyMinutes: 60 }, "the contract comes back signed") === "checks every hour for when the contract comes back signed", "🔴 a polling watch reads as its cadence and its condition");
  ok(aw.watchWords({ kind: "watch", expr: "0 9 * * 1-5" }, "x") === "checks weekdays at 09:00 UTC for when x", "a cron watch reads its cadence in words");
  ok(aw.watchWords({ kind: "cron", expr: "0 9 * * 1" }, "x") === undefined, "a clock routine is not a watch, whatever it carries");
  ok(aw.watchWords({ kind: "event", source: "github" }, undefined) === undefined, "a watch nobody described reads as before");
  ok(registeredEventSources().includes("oe-standard-webhook"), "fixture: the generic webhook contract is registered");
  ok(JSON.stringify(await aw.watchableEventSources()) === "[]", "🔴 GitHub with no probe (no bundle mounts its route) is never offered");
  registerEventReach("github", () => {
    if (githubReach === "throw") throw new Error("probe down");
    return githubReach;
  });
  ok(JSON.stringify(await aw.watchableEventSources()) === "[]", "🔴 GitHub whose route admits no delivery (no webhook secret) is never offered");
  githubReach = "throw";
  ok(JSON.stringify(await aw.watchableEventSources()) === "[]", "🔴 a probe that cannot answer offers nothing");
  githubReach = true;
  ok(JSON.stringify(await aw.watchableEventSources()) === JSON.stringify(["github"]), "🔴 the apps that send events here: GitHub, and never the generic webhook contract");
}

console.log("§2 the seat block");
{
  const block = aw.askWatchBlock(["github", "linear"]);
  ok(block.startsWith('### "Tell me when …"'), "the block has its heading");
  ok(block.includes("Only\nan ask sets up a watch") && block.includes("Never set one up because an app was connected"), "🔴 the block says only an ask sets up a watch");
  ok(block.includes("GitHub, Linear send their events here"), "🔴 the block names the apps that send events here");
  ok(block.includes("only-on-change") && block.includes("every hour"), "🔴 the block names the polling road for any other app");
  ok(block.includes("It\n  posts once on its first check, with what it sees now, and after that only when the answer changes."), "🔴 the block says a polling watch posts its first check, never that it stays quiet");
  ok(block.includes("`watchFor`"), "the block tells the job to set the condition in words");
  ok(block.includes("The routine card is the one confirmation"), "the card is the one confirmation");
  ok(!ID_LIKE.test(block), "the block carries no id");
  ok(aw.askWatchBlock([]).includes("No app sends its events here yet."), "with no app that sends events, the block says so");
  ok(aw.askWatchBlock(["github"]).includes("GitHub sends its events here. For it,"), "one app reads in the singular");
  ok((await aw.askWatchSeatBlock({ binding: dmOf("UAMY", "DAMY"), worker: false })) === aw.askWatchBlock(["github"]), "🔴 a live DM turn reads the block");
  ok((await aw.askWatchSeatBlock({ binding: roomOf("UAMY", "CROOM"), worker: false })) === aw.askWatchBlock(["github"]), "🔴 a live room turn reads the block");
  ok((await aw.askWatchSeatBlock({ binding: dmOf("UAMY", "DAMY"), worker: true })) === "", "🔴 a worker never reads it");
  ok((await aw.askWatchSeatBlock({ binding: { ...dmOf("UAMY", "DAMY"), principalId: undefined } as SurfaceBinding, worker: false })) === "", "🔴 a fire (no acting person) never reads it");
  ok((await aw.askWatchSeatBlock({ binding: { ...dmOf("UAMY", "DAMY"), mode: "mpim" } as unknown as SurfaceBinding, worker: false })) === "", "a group DM never reads it");
  const ctxFor = (person: string, attrs: Record<string, string>) => ({
    channel: { kind: "slack" },
    session: { auth: { current: { principalId: person, attributes: { oe_platform: "slack", team_id: "T1", user_id: person, ...attrs } } } },
  });
  const dm = await renderScopeMarkdown(ctxFor("UAMY", { channel_id: "DAMY", channel_type: "im", dm_partner_trust: "internal" }) as never);
  ok(dm.includes(aw.askWatchBlock(["github"])), "🔴 the REAL seat prompt of a DM turn carries the block");
  ok(dm === (await renderScopeMarkdown(ctxFor("UAMY", { channel_id: "DAMY", channel_type: "im", dm_partner_trust: "internal" }) as never)), "the same bytes on the next turn");
  const room = await renderScopeMarkdown(ctxFor("UAMY", { channel_id: "CROOM", channel_type: "channel", trust_checked: "true" }) as never);
  ok(room.includes(aw.askWatchBlock(["github"])), "🔴 the REAL seat prompt of a room turn carries the block");
  githubReach = false;
  const deafDm = await renderScopeMarkdown(ctxFor("UAMY", { channel_id: "DAMY", channel_type: "im", dm_partner_trust: "internal" }) as never);
  ok(deafDm.includes(aw.askWatchBlock([])) && !deafDm.includes("GitHub sends its events here"), "🔴 the REAL seat prompt never offers a GitHub event watch while GitHub's events do not reach here");
  githubReach = true;
  const taskToken = `oe-dom:paris:win:${taskWindowId("slack/T1/CROOM", "1700.5")}:oe-sup:g1`;
  ok(classifySessionId(taskToken).kind === "task", "fixture guard: the worker token classifies task-grain");
  const worker = await renderScopeMarkdown({ channel: { kind: "channel:unified", continuationToken: taskToken }, session: { auth: { current: { principalId: "UAMY", attributes: { oe_platform: "slack", oe_grain: "task", team_id: "T1", user_id: "UAMY", channel_id: "CROOM", channel_type: "channel", trust_checked: "true" } } } } } as never);
  ok(!worker.includes(aw.askWatchBlock(["github"])), "🔴 the REAL prompt of a worker never carries the block");
  const fire = await renderScopeMarkdown({ channel: { kind: "slack" }, session: { auth: { current: { attributes: { oe_platform: "slack", team_id: "T1", channel_id: "CROOM", channel_type: "channel", trust_checked: "true" } } } } } as never);
  ok(!fire.includes(aw.askWatchBlock(["github"])), "🔴 the REAL prompt of a fire (no acting person) never carries the block");
}

console.log("§3 the real create_routine");
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
const dmCtx = {
  channel: { kind: "slack" },
  session: { auth: { current: { principalId: "UAMY", principalType: "slack-user", attributes: { oe_platform: "slack", team_id: "T1", user_id: "UAMY", channel_id: "DAMY", channel_type: "im", dm_partner_trust: "internal" } } } },
};
const JQ = '.scope.container == "acme/web" and .event == "issues" and .action == "opened"';
const pendingCard = async (needle: string): Promise<RoutineCreateArgs> => {
  const rows = await getOperationalStore().listPendingActions(ORG);
  const row = rows.find((r) => r.kind === "routine.create" && r.argsJson.includes(needle));
  ok(row !== undefined, `the card for "${needle}" is pending`);
  return JSON.parse(row!.argsJson) as RoutineCreateArgs;
};
const card = actionKind("routine.create")!;
const plainArgsLater = (): RoutineCreateArgs => ({ org: ORG, partition: {} as never, surfaceKey: "slack/T1/DAMY", target: {}, trigger: { kind: "cron", expr: "0 9 * * 1" }, prompt: "Post the open bugs." });
{
  const ev = await createTool.execute(
    { prompt: "Tell me about the new issue: its title, who opened it, and a one-line summary.", trigger: { kind: "event", source: "github", jq: JQ }, watchFor: " a new issue is opened in acme/web. " },
    dmCtx,
  );
  ok(ev.pending === true, "an event watch posts a card");
  const args = await pendingCard("a new issue is opened in acme/web");
  ok(args.watchFor === "a new issue is opened in acme/web", "🔴 the card freezes the condition in words");
  const headline = card.plainSummary!(args);
  ok(headline.includes("that watches GitHub for when a new issue is opened in acme/web"), `🔴 the headline names the app and the condition (${headline})`);
  ok(!headline.includes(".scope") && !ID_LIKE.test(headline), "the headline carries no filter and no id");
  const detail = card.summarize(args).join("\n");
  ok(detail.includes("👀 watches for: “a new issue is opened in acme/web”"), "🔴 the detail says what the watch looks for");
  ok(detail.includes(JQ), "…and the metadata still carries the exact filter");
  const visible = card.consequence!(args)!;
  ok(visible.startsWith("watches for “a new issue is opened in acme/web”; it wakes on only events where “"), `🔴 the VISIBLE line shows the whole condition first (${visible.slice(0, 120)})`);
  ok(visible.includes(JQ), "🔴 …and the filter that really decides a post, so the person can compare the two");
  ok(visible.includes("Tell me about the new issue"), "…and the instruction it follows");
  const lineFor = (jq: string): string => card.consequence!({ ...args, trigger: { kind: "event", source: "github", jq } })!;
  ok(lineFor(".count < 5") !== lineFor(".count > 5"), "🔴 a person can tell `< 5` from `> 5` on the visible line");
  const rich = lineFor('.labels[0].name == "bug" and (.fields.additions // 0) > 500 and (.fields.action | IN("opened"))');
  ok(rich.includes('.labels［0］.name == "bug" and (.fields.additions // 0) ＞ 500 and (.fields.action ｜ IN("opened"))'), `🔴 a filter with an index, a comparison and a pipe reads whole (${rich.slice(0, 200)})`);
  ok(!/[<>|[\]]/u.test(rich.split("; it wakes on ")[1]!.split(", and then follows ")[0]!), "…and no raw markup character reaches the line");
  const rendered = consequenceForRow({ kind: "routine.create", argsJson: JSON.stringify({ ...args, trigger: { kind: "event", source: "github", jq: ".count > 5" } }) });
  ok(rendered?.includes("“.count ＞ 5”") === true, "🔴 the card's real row renderer keeps the operator too");
  const noFilter = card.consequence!({ ...args, trigger: { kind: "event", source: "github" } })!;
  ok(noFilter.includes("it wakes on EVERY event from GitHub"), "🔴 a watch with no filter says it wakes on every event");

  const poll = await createTool.execute(
    { prompt: "Read the contracts folder. Record whether the Acme contract is signed, and who signed it.", trigger: { kind: "scheduled", everyMinutes: 60, postPolicy: "only-on-change" }, watchFor: "the Acme contract comes back signed" },
    dmCtx,
  );
  ok(poll.pending === true, "a polling watch posts a card");
  const pArgs = await pendingCard("the Acme contract comes back signed");
  ok(card.plainSummary!(pArgs).includes("that checks every hour for when the Acme contract comes back signed"), "🔴 a polling watch's headline names its cadence and condition");
  ok(card.consequence!(pArgs)!.startsWith("watches for “the Acme contract comes back signed”; each check follows “"), "🔴 a polling watch's visible line shows the condition, then the instruction");
  const longest = "x".repeat(aw.WATCH_FOR_MAX_CHARS);
  ok(card.consequence!({ ...pArgs, watchFor: longest })!.includes(`“${longest}”`), "🔴 the longest condition the tool accepts shows whole on the visible line");
  ok(card.consequence!(plainArgsLater())!.startsWith("“"), "negative control: a routine with no condition shows only its instruction");

  await refuses(
    () => createTool.execute({ prompt: "Post the open bugs.", trigger: { kind: "scheduled", cron: "0 9 * * 1", postPolicy: "every-run" }, watchFor: "bugs" }, dmCtx),
    "`watchFor` names what a watch looks for",
    "🔴 a condition on a clock routine is refused",
  );
  await refuses(
    () => createTool.execute({ prompt: "x", trigger: { kind: "event", source: "github", jq: JQ }, watchFor: "y".repeat(200) }, dmCtx),
    "Shorten it",
    "a condition over the limit is refused at the tool",
  );
  await refuses(
    () => createTool.execute({ prompt: "x", trigger: { kind: "event", source: "gmail" }, watchFor: "the contract comes back" }, dmCtx),
    "only-on-change",
    "🔴 an app with no events here is refused with the polling road named",
  );
  const plain = await createTool.execute({ prompt: "Post the open bugs.", trigger: { kind: "scheduled", cron: "0 9 * * 1", postPolicy: "every-run" } }, dmCtx);
  ok(plain.pending === true, "a routine with no condition still posts its card");
  const plainArgs = await pendingCard("Post the open bugs.");
  ok(plainArgs.watchFor === undefined && card.plainSummary!(plainArgs).startsWith("Start a routine in"), "negative control: a routine with no condition reads as before");

  console.log("§4 the click, and the person's list");
  await card.execute(args, "UAMY");
  await card.execute(pArgs, "UAMY");
  await card.execute(plainArgs, "UAMY");
  const rows = await listAllRoutines();
  const evRow = rows.find((r) => r.trigger.kind === "event");
  const pollRow = rows.find((r) => r.trigger.kind === "watch");
  ok(evRow?.watchFor === "a new issue is opened in acme/web", "🔴 the armed event routine carries the condition");
  ok(pollRow?.watchFor === "the Acme contract comes back signed", "🔴 the armed polling routine carries the condition");
  ok(rows.find((r) => r.trigger.kind === "cron")?.watchFor === undefined, "a clock routine carries none");
  ok((card.doneSummary as (a: RoutineCreateArgs) => string)(args).includes("started a watch in"), "the outcome says a watch started");
  const me = { org: ORG, platform: "slack", workspace: "T1", personId: "UAMY", dmSurfaceKey: "slack/T1/DAMY", trust: "internal" as const };
  const list = await doingForPerson(me, { routines: async () => rows });
  const lines = list.items.map((i) => `${i.label}: ${i.text}`);
  ok(lines.includes("Watch: Watches GitHub for when a new issue is opened in acme/web"), `🔴 the list shows the event watch in words (${lines.join(" | ")})`);
  ok(lines.includes("Watch: Checks every hour for when the Acme contract comes back signed"), "🔴 the list shows the polling watch in words");
  ok(!lines.some((l) => l.includes(".scope") || l.includes("on github event")), "🔴 no line carries the raw filter");
  ok(lines.some((l) => l.startsWith("Routine: ") && l.includes("Post the open bugs.")), "negative control: a clock routine still shows its prompt in the DM");

  console.log("§5 an edit clears a stale condition");
  const edit = actionKind("routine.edit")!;
  const editArgs = (r: Routine, prompt: string) => ({
    org: ORG,
    partition: args.partition,
    surfaceKey: r.surfaceKey,
    id: r.id,
    prompt,
    previousPrompt: r.prompt,
    description: "x",
    requestedBy: "UAMY",
    trigger: r.trigger,
    generation: r.promptGeneration ?? 0,
  });
  await edit.execute(editArgs(pollRow!, "Read the contracts folder. Record whether the Beta contract is signed.") as never, "UAMY");
  await edit.execute(editArgs(evRow!, "Tell me the new issue's title only.") as never, "UAMY");
  const after = await listAllRoutines();
  ok(after.find((r) => r.id === pollRow!.id)?.watchFor === undefined, "🔴 a new prompt on a polling watch clears its condition, so the list cannot misname it");
  ok(after.find((r) => r.id === evRow!.id)?.watchFor === "a new issue is opened in acme/web", "an event watch keeps it: its filter did not change");

  console.log("§7 an app whose events do not reach here");
  const { sweepEventReach, unreachableNoticeText, reachableAgainNoticeText, MAX_REACH_NOTICES_PER_TICK } = await import("../agent/schedules/event-reach-sweep.js");
  const { updateRoutine, addRoutine } = await import("../agent/routines/store.js");
  const { dispatchTick } = await import("../agent/schedules/dispatch.js");
  ok((await eventReach("my-ci", { hooks: () => [{ id: "my-ci", source: "oe-standard-webhook" } as never] })) === "reaches", "a declared hook's deliveries reach here");
  ok((await eventReach("gmail", { hooks: () => [] })) === "unknown", "🔴 a source with no probe is unknown, so nothing refuses or posts on a guess");
  githubReach = "throw";
  ok((await eventReach("github", { hooks: () => [] })) === "unknown", "🔴 a probe that throws is unknown, never deaf");
  githubReach = false;
  ok((await eventReach("github", { hooks: () => [] })) === "deaf", "a probe that says no is deaf");

  await refuses(
    () => createTool.execute({ prompt: "Tell me about it.", trigger: { kind: "event", source: "github", jq: JQ }, watchFor: "a pull request is merged in acme/web" }, dmCtx),
    "GitHub's events don't reach this deployment",
    "🔴 an event watch on an app whose events do not reach here is refused",
  );
  await refuses(
    () => createTool.execute({ prompt: "Tell me about it.", trigger: { kind: "event", source: "github", jq: JQ } }, dmCtx),
    "GitHub's events don't reach this deployment, so a routine on them would never fire. Set it up as a check on a schedule instead (`postPolicy: \"only-on-change\"`)",
    "🔴 …and so is an event routine with no condition, with the polling road named",
  );

  const posts: string[] = [];
  const sweepDeps = { resolveTarget: () => ({ origin: { kind: "fixture" } }) as never, post: async (_o: unknown, text: string) => (posts.push(text), "ts") };
  const evId = evRow!.id;
  const live = async (): Promise<Routine> => (await listAllRoutines()).find((r) => r.id === evId)!;
  const t0 = new Date("2026-10-14T12:00:00.000Z");
  let res = await sweepEventReach(await listAllRoutines(), t0, sweepDeps);
  ok(res.told === 1 && posts.length === 1, `🔴 an armed watch on an app that stopped delivering tells its room (told ${res.told}, posts ${posts.length})`);
  const told = posts[0]!;
  ok(told === unreachableNoticeText(await live()), "the room reads the host-composed line");
  ok(told.includes("GitHub's events no longer reach me, so this watch can't fire") && told.includes("watches GitHub for when a new issue is opened in acme/web"), `🔴 the line names the app and the watch in words (${told})`);
  ok(told.includes("check on a schedule instead"), "the line names the way out");
  ok(!ID_LIKE.test(told) && !told.includes(evId) && !told.includes(".scope"), "🔴 the line carries no id and no filter");
  ok((await live()).unreachableSince === t0.toISOString() && (await live()).status === "active", "🔴 the row is marked, and the routine stays active");
  res = await sweepEventReach(await listAllRoutines(), new Date(t0.getTime() + 60_000), sweepDeps);
  ok(res.told === 0 && posts.length === 1, "🔴 the next tick tells the room nothing new");
  githubReach = "throw";
  res = await sweepEventReach(await listAllRoutines(), new Date(t0.getTime() + 120_000), sweepDeps);
  ok(res.told + res.recovered === 0 && posts.length === 1 && (await live()).unreachableSince !== undefined, "🔴 an unknown answer changes nothing");
  githubReach = true;
  res = await sweepEventReach(await listAllRoutines(), new Date(t0.getTime() + 180_000), sweepDeps);
  ok(res.recovered === 1 && posts.length === 2 && posts[1]!.startsWith("✅ GitHub's events reach me again, so this watch works again"), `🔴 the room is told when the app delivers again (${posts[1] ?? "none"})`);
  ok((await live()).unreachableSince === undefined, "🔴 the mark clears, so a later outage is told too");
  ok(posts[1] === reachableAgainNoticeText(await live()) && !ID_LIKE.test(posts[1]!), "the room reads the host-composed line, with no id");
  res = await sweepEventReach(await listAllRoutines(), new Date(t0.getTime() + 240_000), sweepDeps);
  ok(res.told + res.recovered === 0 && posts.length === 2, "negative control: a watch whose app delivers posts nothing");
  githubReach = false;
  await sweepEventReach(await listAllRoutines(), t0, sweepDeps);
  ok(posts.length === 3 && (await live()).unreachableSince !== undefined, "fixture: the watch is marked deaf again");
  await updateRoutine(ORG, evRow!.surfaceKey, evId, { status: "disabled" });
  res = await sweepEventReach(await listAllRoutines(), t0, sweepDeps);
  ok(res.told + res.recovered === 0 && posts.length === 3 && (await live()).unreachableSince === undefined, "🔴 a stopped routine loses its mark, and its room hears nothing");
  await updateRoutine(ORG, evRow!.surfaceKey, evId, { status: "active" });
  res = await sweepEventReach(await listAllRoutines(), t0, sweepDeps);
  ok(res.told === 1 && posts.length === 4, "🔴 a watch re-enabled while its app is still deaf tells its room again");
  githubReach = true;
  await sweepEventReach(await listAllRoutines(), t0, sweepDeps);
  ok((await live()).unreachableSince === undefined, "fixture: the watch is back");
  const extra = MAX_REACH_NOTICES_PER_TICK + 2;
  for (let i = 0; i < extra; i++) await addRoutine({ org: ORG, surfaceKey: evRow!.surfaceKey } as never, { ...(await live()), id: `${evId}-cap${i}`, unreachableSince: undefined });
  githubReach = false;
  const capPosts: string[] = [];
  const capDeps = { ...sweepDeps, post: async (_o: unknown, text: string) => (capPosts.push(text), "ts") };
  res = await sweepEventReach(await listAllRoutines(), t0, capDeps);
  ok(res.told === MAX_REACH_NOTICES_PER_TICK && capPosts.length === MAX_REACH_NOTICES_PER_TICK, `🔴 one tick posts at most ${MAX_REACH_NOTICES_PER_TICK} lines (posted ${capPosts.length})`);
  res = await sweepEventReach(await listAllRoutines(), t0, capDeps);
  ok(res.told === extra + 1 - MAX_REACH_NOTICES_PER_TICK, `🔴 the rest carry over to the next tick (told ${res.told})`);
  for (const r of (await listAllRoutines()).filter((x) => x.id.startsWith(`${evId}-cap`))) await updateRoutine(ORG, r.surfaceKey, r.id, { status: "disabled" });
  await sweepEventReach(await listAllRoutines(), t0, capDeps);
  githubReach = true;
  await sweepEventReach(await listAllRoutines(), t0, sweepDeps);
  const clockOnly = (await listAllRoutines()).filter((r) => r.trigger.kind !== "event");
  githubReach = false;
  ok((await sweepEventReach(clockOnly, t0, sweepDeps)).told === 0, "negative control: a clock routine is never told");
  ok((await sweepEventReach([{ ...(await live()), status: "disabled" }], t0, sweepDeps)).told === 0, "negative control: a stopped routine is never told");

  const tickPosts: string[] = [];
  await dispatchTick({
    to: (() => {
      throw new Error("no fire expected");
    }) as never,
    waitUntil: () => undefined,
    appAuth: {} as never,
    now: new Date(),
    eventReach: { resolveTarget: sweepDeps.resolveTarget, post: async (_o: unknown, text: string) => (tickPosts.push(text), "ts") },
  } as never);
  ok(tickPosts.length === 1 && tickPosts[0]!.includes("GitHub's events no longer reach me"), `🔴 the REAL dispatcher tick tells the room (posts: ${tickPosts.length})`);
  githubReach = true;
}

console.log("§6 only an ask arms a routine");
{
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const roots = ["packages/core/agent", "packages/adapters", "agent", ...readdirSync(join(repo, "packages/providers")).map((p) => `packages/providers/${p}/agent`)];
  const callers: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (e === "node_modules" || e === "dist" || e === "generated") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && /\baddRoutine\(/u.test(readFileSync(p, "utf8").replace(/\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, ""))) callers.push(relative(repo, p));
    }
  };
  for (const r of roots) walk(join(repo, r));
  callers.sort();
  const expected = [
    "packages/core/agent/approvals/routine-create.ts",
    "packages/core/agent/operational/postgres.ts",
    "packages/core/agent/operational/sqlite.ts",
    "packages/core/agent/operational/store.ts",
    "packages/core/agent/routines/store.ts",
    "packages/core/agent/tools/subscribe_pr.ts",
  ];
  ok(JSON.stringify(callers) === JSON.stringify(expected), `🔴 only a card click, an explicit PR follow and the store arm a routine; connecting an app arms nothing (found: ${callers.join(", ")})`);
  ok(!callers.some((c) => c.includes("/connections/") || c.includes("/channels/")), "🔴 no connection or channel module arms a routine");
}

console.log("§8 the webhook tools name an app's own event stream");
{
  const listTool = (await import("../agent/tools/list_webhooks.js")).default as unknown as { execute(input: unknown, ctx: unknown): Promise<{ appSources: { source: string; app: string }[]; message: string }> };
  const { unknownHookMessage, readDeliveryHistory } = await import("../agent/control/delivery-history.js");
  const { readCaptureWindow, armCaptureWindow } = await import("../agent/control/capture-window-read.js");
  const partition = { org: ORG, surfaceKey: "slack/T1/CROOM" } as never;
  const ROAD = 'create_routine (trigger kind "event", source "github")';
  githubReach = true;
  const listed = await listTool.execute({}, {});
  ok(JSON.stringify(listed.appSources) === JSON.stringify([{ source: "github", app: "GitHub" }]), `🔴 list_webhooks names GitHub as an app source that reaches here (${JSON.stringify(listed.appSources)})`);
  ok(listed.message.startsWith("no inbound webhooks are declared") && listed.message.includes("GitHub sends its own events here, with no declared webhook") && listed.message.includes(ROAD), `🔴 with no declared hook, list_webhooks still says how to subscribe to GitHub (${listed.message})`);
  const note = await unknownHookMessage("GitHub");
  ok(note.includes('"github" is not a declared webhook') && note.includes(ROAD) && !note.startsWith("no inbound webhook"), `🔴 a lookup of "github" names the road that works (${note})`);
  for (const [label, run] of [
    ["read_webhook_history", () => readDeliveryHistory({ partition, source: "github" })],
    ["list_recent_events", () => readCaptureWindow({ partition, source: "github" })],
    ["capture_events", () => armCaptureWindow({ partition, source: "github" } as never)],
  ] as const) {
    const res = (await (run as () => Promise<{ ok: boolean; message?: string }>)()) as { ok: boolean; message?: string };
    ok(!res.ok && res.message === note, `🔴 ${label} on "github" answers with the app-source road (${res.message ?? ""})`);
  }
  ok((await unknownHookMessage("my-ci")) === 'no inbound webhook named "my-ci" exists for this org — check the name with list_webhooks.', "negative control: a name that is no app source reads as before");
  const baseConfig = { loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [] };
  registerConfig({ ...baseConfig, loadWebhooks: () => [{ id: "github", source: "oe-standard-webhook", readableBy: [{ level: "org" }] } as never] } as never);
  const shadowed = await listTool.execute({}, {});
  ok(shadowed.appSources.length === 0 && !shadowed.message.includes("with no declared webhook") && shadowed.message.startsWith("1 inbound webhook"), `🔴 a declared hook named "github" is listed once, and never also as an app source (${shadowed.message})`);
  registerConfig(baseConfig as never);
  githubReach = false;
  const deaf = await listTool.execute({}, {});
  ok(deaf.appSources.length === 0 && !deaf.message.includes("GitHub"), "🔴 negative control: GitHub whose events do not reach here is never named");
  ok((await unknownHookMessage("github")).startsWith('no inbound webhook named "github"'), "🔴 negative control: a lookup of a deaf app reads as before");
  githubReach = true;
}

removeTempDir(tmp);
console.log(`✓ ask-watch: ${n} assertions`);
