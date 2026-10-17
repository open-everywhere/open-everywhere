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
  ok(JSON.stringify(aw.watchableEventSources()) === JSON.stringify(["github"]), "🔴 the apps that send events here: GitHub, and never the generic webhook contract");
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
  ok(aw.askWatchSeatBlock({ binding: dmOf("UAMY", "DAMY"), worker: false }) === aw.askWatchBlock(), "🔴 a live DM turn reads the block");
  ok(aw.askWatchSeatBlock({ binding: roomOf("UAMY", "CROOM"), worker: false }) === aw.askWatchBlock(), "🔴 a live room turn reads the block");
  ok(aw.askWatchSeatBlock({ binding: dmOf("UAMY", "DAMY"), worker: true }) === "", "🔴 a worker never reads it");
  ok(aw.askWatchSeatBlock({ binding: { ...dmOf("UAMY", "DAMY"), principalId: undefined } as SurfaceBinding, worker: false }) === "", "🔴 a fire (no acting person) never reads it");
  ok(aw.askWatchSeatBlock({ binding: { ...dmOf("UAMY", "DAMY"), mode: "mpim" } as unknown as SurfaceBinding, worker: false }) === "", "a group DM never reads it");
  const ctxFor = (person: string, attrs: Record<string, string>) => ({
    channel: { kind: "slack" },
    session: { auth: { current: { principalId: person, attributes: { oe_platform: "slack", team_id: "T1", user_id: person, ...attrs } } } },
  });
  const dm = await renderScopeMarkdown(ctxFor("UAMY", { channel_id: "DAMY", channel_type: "im", dm_partner_trust: "internal" }) as never);
  ok(dm.includes(aw.askWatchBlock()), "🔴 the REAL seat prompt of a DM turn carries the block");
  ok(dm === (await renderScopeMarkdown(ctxFor("UAMY", { channel_id: "DAMY", channel_type: "im", dm_partner_trust: "internal" }) as never)), "the same bytes on the next turn");
  const room = await renderScopeMarkdown(ctxFor("UAMY", { channel_id: "CROOM", channel_type: "channel", trust_checked: "true" }) as never);
  ok(room.includes(aw.askWatchBlock()), "🔴 the REAL seat prompt of a room turn carries the block");
  const taskToken = `oe-dom:paris:win:${taskWindowId("slack/T1/CROOM", "1700.5")}:oe-sup:g1`;
  ok(classifySessionId(taskToken).kind === "task", "fixture guard: the worker token classifies task-grain");
  const worker = await renderScopeMarkdown({ channel: { kind: "channel:unified", continuationToken: taskToken }, session: { auth: { current: { principalId: "UAMY", attributes: { oe_platform: "slack", oe_grain: "task", team_id: "T1", user_id: "UAMY", channel_id: "CROOM", channel_type: "channel", trust_checked: "true" } } } } } as never);
  ok(!worker.includes(aw.askWatchBlock()), "🔴 the REAL prompt of a worker never carries the block");
  const fire = await renderScopeMarkdown({ channel: { kind: "slack" }, session: { auth: { current: { attributes: { oe_platform: "slack", team_id: "T1", channel_id: "CROOM", channel_type: "channel", trust_checked: "true" } } } } } as never);
  ok(!fire.includes(aw.askWatchBlock()), "🔴 the REAL prompt of a fire (no acting person) never carries the block");
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

removeTempDir(tmp);
console.log(`✓ ask-watch: ${n} assertions`);
