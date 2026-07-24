import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { routineMarker, type Routine } from "../agent/routines/routine.js";
import { WATCH_SILENCE_SENTINEL, WATCH_STATE_TOOL } from "../agent/routines/watch.js";
import { NO_REPLY_SENTINEL } from "../agent/channels/turn-delivery.js";
import { bindFrom, type BindableContext } from "../agent/identity/binding.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { registerConfig, getConfig } from "../agent/access/config.js";
import { defineDomain, domainForChannel } from "../agent/memory/domain.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-dispatch-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ROUTINE_MAX_CONCURRENCY = "2";

const store = await import("../agent/routines/store.js");
const dispatch = await import("../agent/schedules/dispatch.js");

const now = new Date("2026-07-02T12:00:00.000Z");
const past = new Date(now.getTime() - 60_000).toISOString();
const N = 5;

for (let i = 0; i < N; i++) {
  const r: Routine = {
    id: `r-${i}`,
    org: "default",
    surfaceKey: "slack/T1/C1",
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: `routine ${i}`,
    createdAt: now.toISOString(),
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: past,
    target: { channelId: "C1" },
  };
  await store.addRoutine({} as never, r);
}
ok((await store.listAllRoutines()).length === N, "seeded all N due routines");

const firedMessages: Record<string, string> = {};
async function tick(): Promise<string[]> {
  const started: string[] = [];
  const receive = ((_channel: unknown, opts: { message?: string; auth?: { attributes?: Record<string, unknown> } }) => {
    const mk = routineMarker(opts.auth?.attributes as never);
    if (mk) {
      started.push(mk.id);
      firedMessages[mk.id] = opts.message ?? "";
    }
    return Promise.resolve();
  }) as never;
  const args = {
    now,
    receive,
    waitUntil: (_p: Promise<unknown>) => {},
    appAuth: { attributes: {} } as never,
  };
  await dispatch.dispatchTick(args as never);
  return started;
}

const cap = 2;
const allFired: string[] = [];
let ticks = 0;
while (allFired.length < N && ticks < 10) {
  const started = await tick();
  ok(started.length <= cap, `tick ${ticks}: started ${started.length} <= cap ${cap}`);
  for (const id of started) ok(!allFired.includes(id), `routine ${id} fired only once (no double-fire)`);
  allFired.push(...started);
  ticks++;
}

ok(allFired.length === N, "every routine eventually fired");
ok(new Set(allFired).size === N, "all N distinct routines fired exactly once");
ok(ticks === Math.ceil(N / cap), `took the expected number of ticks (${Math.ceil(N / cap)}) at cap ${cap}`);

ok((await tick()).length === 0, "no routine is left over-due after the backlog drains");

ok(WATCH_SILENCE_SENTINEL === NO_REPLY_SENTINEL, "watch protocol's silence sentinel matches the channel's NO_REPLY sentinel");

ok(
  firedMessages["r-0"].includes("routine 0") && !firedMessages["r-0"].includes(WATCH_STATE_TOOL),
  "an interval fire sends the prompt without the watch protocol",
);
ok(
  firedMessages["r-0"].startsWith("[routine r-0] Scheduled fire") && firedMessages["r-0"].includes("this is the FIRST run"),
  "a first fire's preamble carries the routine's creation time and says it's the first run",
);

const watch: Routine = {
  id: "r-watch",
  org: "default",
  surfaceKey: "slack/T1/C1",
  trigger: { kind: "watch", everyMinutes: 15 },
  prompt: "watch the status page for incidents",
  createdAt: now.toISOString(),
  status: "active",
  consecutiveFailures: 0,
  nextRunAt: past,
  lastOutcome: "skipped",
  target: { channelId: "C1" },
};
await store.addRoutine({} as never, watch);
ok((await tick()).includes("r-watch"), "a due watch routine fires");

const wmsg = firedMessages["r-watch"] ?? "";
ok(wmsg !== watch.prompt && wmsg.includes(watch.prompt), "a watch fire wraps the prompt (not bare interval execution)");
ok(wmsg.includes(WATCH_STATE_TOOL), "the watch turn is told to record its observation via record_watch_state");
ok(wmsg.includes(WATCH_SILENCE_SENTINEL), "the watch turn is taught the silence sentinel for the unchanged case");

const watchAfter = await store.getRoutine("default", "slack/T1/C1", "r-watch");
ok(watchAfter?.lastOutcome === undefined, "a fire CLEARS lastOutcome (outcome pending — the settleOutcome invariant)");
ok(watchAfter?.lastStateHash === undefined, "dispatch never invents a state hash (the tool records the observation)");

{
  const prevRun = "2026-07-02T11:00:00.000Z";
  const again: Routine = {
    id: "r-again",
    org: "default",
    surfaceKey: "slack/T1/C1",
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: "report new commits since the last run",
    createdAt: "2026-07-01T09:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: past,
    lastRunAt: prevRun,
    target: { channelId: "C1" },
  };
  await store.addRoutine({} as never, again);
  ok((await tick()).includes("r-again"), "the seeded repeat routine fires");
  ok(
    firedMessages["r-again"].includes(`previous run: ${prevRun}`) && firedMessages["r-again"].includes("2026-07-01T09:00:00.000Z"),
    "a repeat fire's preamble carries the PREVIOUS run time and the creation time",
  );
  ok(wmsg.startsWith("[routine r-watch] Scheduled fire"), "watch fires get the same temporal preamble ahead of the protocol");
}

{
  const onceR: Routine = {
    id: "r-once",
    org: "default",
    surfaceKey: "slack/T1/C1",
    trigger: { kind: "once", at: "2026-07-02T11:55:00.000Z" },
    prompt: "check the release notes and summarise",
    createdAt: "2026-07-02T10:55:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: past,
    target: { channelId: "C1" },
  };
  await store.addRoutine({} as never, onceR);
  ok((await tick()).includes("r-once"), "a due once routine fires");

  const onceMsg = firedMessages["r-once"] ?? "";
  ok(
    onceMsg.startsWith("[routine r-once] Scheduled fire") && onceMsg.includes(onceR.prompt) && !onceMsg.includes(WATCH_STATE_TOOL),
    "a once fire gets the plain temporal-preamble + prompt (renderScheduledMessage), NOT the watch protocol",
  );

  const onceAfter = await store.getRoutine("default", "slack/T1/C1", "r-once");
  ok(onceAfter?.status === "disabled", "a fired once routine DISABLES itself (not deleted — kept for list/audit visibility)");
  ok(onceAfter?.disabledReason?.includes("once: fired at") === true, "the disable reason carries a fired-at marker");
  ok(onceAfter?.nextRunAt === null, "a fired once routine's nextRunAt goes to null (no next occurrence, ever)");
  ok(onceAfter?.trigger.kind === "once" && (onceAfter.trigger as { at: string }).at === "2026-07-02T11:55:00.000Z", "the once trigger's `at` is untouched by firing");

  ok(!(await tick()).includes("r-once"), "a fired once routine never fires again on a later tick");

  const { describeTrigger } = await import("../agent/routines/routine.js");
  ok(describeTrigger(onceAfter!.trigger) === "once at 2026-07-02T11:55:00.000Z (fires once, then disables)", "describeTrigger renders the once trigger sensibly");
}

const opStore = (await import("../agent/operational/provider.js")).getOperationalStore();
await opStore.setSpendLimit("default", "slack/T1/C2", "surface", { monthlyTokens: 100 });
await opStore.recordUsage("default", "slack/T1/C2", "2026-07", { inputTokens: 90, outputTokens: 20 });

const capped: Routine = {
  id: "r-capped",
  org: "default",
  surfaceKey: "slack/T1/C2",
  trigger: { kind: "interval", everyMinutes: 30 },
  prompt: "expensive recurring work",
  createdAt: now.toISOString(),
  status: "active",
  consecutiveFailures: 0,
  nextRunAt: past,
  target: { channelId: "C2" },
};
await store.addRoutine({} as never, capped);
ok((await tick()).length === 0, "an over-budget routine does NOT start a session");

const cappedAfter = await store.getRoutine("default", "slack/T1/C2", "r-capped");
ok(cappedAfter?.lastOutcome === "skipped", "a budget-declined fire records `skipped` (a correct nothing-to-do, not a failure)");
ok(cappedAfter?.consecutiveFailures === 0, "a budget decline never counts toward self-disable");
ok(
  cappedAfter?.nextRunAt !== undefined && cappedAfter?.nextRunAt !== null && Date.parse(cappedAfter.nextRunAt) > now.getTime(),
  "a budget decline advances the schedule (retries at its cadence, not every tick)",
);

{
  const onceCapped: Routine = {
    id: "r-once-capped",
    org: "default",
    surfaceKey: "slack/T1/C2",
    trigger: { kind: "once", at: "2026-07-02T11:55:00.000Z" },
    prompt: "expensive one-shot check",
    createdAt: "2026-07-02T10:55:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: past,
    target: { channelId: "C2" },
  };
  await store.addRoutine({} as never, onceCapped);
  ok((await tick()).length === 0, "an over-budget once routine does NOT start a session either");
  const onceCappedAfter = await store.getRoutine("default", "slack/T1/C2", "r-once-capped");
  ok(onceCappedAfter?.status === "disabled", "a budget-declined once routine also self-disables (its one shot is used)");
  ok(onceCappedAfter?.disabledReason?.includes("once: declined") === true, "the disable reason distinguishes a decline from an actual fire");
  ok(onceCappedAfter?.lastOutcome === "skipped", "a budget-declined once routine still records `skipped`, same as any other kind");
  ok(onceCappedAfter?.nextRunAt === null, "a budget-declined once routine's nextRunAt is null (never retried — recreate a fresh one-shot instead)");
}

const testDomains = [defineDomain({ name: "watched", channels: ["slack/T9/C9"] })];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => testDomains,
  loadSilos: () => [],
  domainsForSurface: (p) => {
    const d = domainForChannel(`${p.workspaceKey}/${p.surface}`, testDomains);
    return d ? [d.name] : [];
  },
});

const surfaceRoutine: Routine = {
  id: "r-surface",
  org: "default",
  surfaceKey: "slack/T9/C9",
  trigger: { kind: "interval", everyMinutes: 60 },
  prompt: "check the thing",
  createdAt: now.toISOString(),
  status: "active",
  consecutiveFailures: 0,
  nextRunAt: past,
  target: { channelId: "C9" },
};
await store.addRoutine({} as never, surfaceRoutine);

let capturedAuth: { attributes?: Record<string, unknown> } | null = null;
const captureReceive = ((_channel: unknown, opts: { auth?: { attributes?: Record<string, unknown> } }) => {
  const mk = routineMarker(opts.auth?.attributes as never);
  if (mk?.id === "r-surface") capturedAuth = (opts.auth ?? null) as never;
  return Promise.resolve();
}) as never;
await dispatch.dispatchTick({
  now,
  receive: captureReceive,
  waitUntil: (_p: Promise<unknown>) => {},
  appAuth: { attributes: {} } as never,
  confirmInternal: async () => true,
} as never);

ok(capturedAuth !== null, "item 15: the routine fired and its auth was captured");

const firedCtx: BindableContext = {
  channel: { kind: "slack" },
  session: { auth: { current: capturedAuth as never } },
};
const binding = bindFrom(firedCtx);
ok(binding.platform === "slack", "item 15: bindFrom resolves platform slack for a routine fire");
ok(binding.workspace === "T9", "item 15: bindFrom resolves the routine's REAL workspace (team_id) — not the env fallback (\"dev\")");
ok(binding.surface === "C9", "item 15: bindFrom resolves the routine's REAL surface (channel_id) — not the env fallback (\"default\")");
ok(binding.principalId === undefined, "item 15: no fake user principal is stamped on a routine fire (correctly absent)");

const firedPartition = resolvePartition(firedCtx);
ok(
  firedPartition.surfaceKey === "slack/T9/C9",
  "item 15: resolvePartition resolves the routine's REAL surfaceKey (spend/usage attribution lands on the right surface)",
);

const firedDomains = getConfig().domainsForSurface({ workspaceKey: firedPartition.workspaceKey, surface: firedPartition.surface });
ok(
  firedDomains.includes("watched"),
  "item 15: domainsForSurface resolves the routine's channel to its configured domain (bundle/skill grants arm for the routine's surface)",
);

ok(
  binding.trust === "internal",
  "trust: a fire whose live conversations.info check confirms internal binds trust=internal (runtime domain skills + shared memory arm)",
);

await store.updateRoutine(surfaceRoutine.org, surfaceRoutine.surfaceKey, surfaceRoutine.id, { nextRunAt: past, lastOutcome: undefined });
capturedAuth = null;
await dispatch.dispatchTick({
  now,
  receive: captureReceive,
  waitUntil: (_p: Promise<unknown>) => {},
  appAuth: { attributes: {} } as never,
  confirmInternal: async () => false,
} as never);
ok(capturedAuth !== null, "trust: the routine re-fired for the unconfirmed case");
const unconfirmedBinding = bindFrom({
  channel: { kind: "slack" },
  session: { auth: { current: capturedAuth as never } },
});
ok(
  unconfirmedBinding.trust === "external",
  "trust: an UNCONFIRMED fire binds trust=external (fail-closed — domain-skills tier and shared memory stay off)",
);
ok(
  unconfirmedBinding.workspace === "T9" && unconfirmedBinding.surface === "C9",
  "trust: the unconfirmed fire still resolves its real surface (spend attribution unaffected by the trust gate)",
);

const discordChannel = (await import("../agent/channels/discord.js")).default;
const teamsChannel = (await import("../agent/channels/teams.js")).default;

interface CapturedFire {
  readonly channel: unknown;
  readonly target: Record<string, unknown>;
  readonly attributes: Record<string, unknown>;
}
const fires: Record<string, CapturedFire> = {};
async function tickCapture(): Promise<string[]> {
  const started: string[] = [];
  const receive = ((
    channel: unknown,
    opts: { target?: Record<string, unknown>; auth?: { attributes?: Record<string, unknown> } },
  ) => {
    const mk = routineMarker(opts.auth?.attributes as never);
    if (mk) {
      started.push(mk.id);
      fires[mk.id] = { channel, target: opts.target ?? {}, attributes: opts.auth?.attributes ?? {} };
    }
    return Promise.resolve();
  }) as never;
  for (let i = 0; i < 10; i++) {
    const before = started.length;
    await dispatch.dispatchTick({
      now,
      receive,
      waitUntil: (_p: Promise<unknown>) => {},
      appAuth: { attributes: {} } as never,
      confirmInternal: async () => true,
    } as never);
    if (started.length === before) break;
  }
  return started;
}
function seed(partial: Pick<Routine, "id" | "surfaceKey" | "target">): Promise<Routine> {
  const r: Routine = {
    org: "default",
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: `cross-surface ${partial.id}`,
    createdAt: now.toISOString(),
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: past,
    ...partial,
  };
  return store.addRoutine({} as never, r);
}

await seed({ id: "r-dc-guild", surfaceKey: "discord/G1/CH1", target: { channelId: "CH1", guildId: "G1", channelType: "0" } });
{
  const started = await tickCapture();
  ok(started.includes("r-dc-guild"), "cross-surface: discord routines fire");

  const dcGuild = fires["r-dc-guild"];
  ok(dcGuild.channel === discordChannel, "discord: fires into the discord channel module");
  ok(JSON.stringify(dcGuild.target) === JSON.stringify({ channelId: "CH1" }), "discord: receive target is the strict { channelId } shape (guildId/channelType stripped — they feed attributes)");
  ok(dcGuild.attributes["guild_id"] === "G1" && dcGuild.attributes["channel_id"] === "CH1" && dcGuild.attributes["channel_type"] === "0", "discord: fire stamps guild/channel/type for bindDiscord");
  const dcBinding = bindFrom({ channel: { kind: "discord" }, session: { auth: { current: { attributes: dcGuild.attributes } as never } } });
  ok(dcBinding.workspace === "G1" && dcBinding.surface === "CH1" && dcBinding.mode === "channel", "discord: bindFrom re-derives the routine's REAL guild/channel partition");
}

await seed({ id: "r-dc-legacy", surfaceKey: "discord/G2/CH2", target: { channelId: "CH2" } });
{
  ok((await tickCapture()).includes("r-dc-legacy"), "discord: a legacy { channelId }-only target still fires");
  const legacy = fires["r-dc-legacy"];
  ok(legacy.attributes["guild_id"] === "G2", "discord: legacy fire recovers guild_id from the surfaceKey's workspace segment");
  const b = bindFrom({ channel: { kind: "discord" }, session: { auth: { current: { attributes: legacy.attributes } as never } } });
  ok(b.workspace === "G2" && b.surface === "CH2", "discord: legacy fire still attributes to the routine's real partition");
}

await seed({
  id: "r-teams-ch",
  surfaceKey: "teams/TEN1/19-eng-thread.tacv2",
  target: {
    serviceUrl: "https://smba.trafficmanager.net/uk/",
    conversationId: "19:eng@thread.tacv2",
    tenantId: "TEN1",
    channelId: "19:eng@thread.tacv2",
    teamId: "19:team@thread.tacv2",
    conversationType: "channel",
  },
});
await seed({
  id: "r-teams-dm",
  surfaceKey: "teams/TEN1/a-1user",
  target: { serviceUrl: "https://smba.trafficmanager.net/uk/", conversationId: "a:1user", conversationType: "personal" },
});
{
  const started = await tickCapture();
  ok(started.includes("r-teams-ch") && started.includes("r-teams-dm"), "teams: routines with a stored conversation reference fire");
  const ch = fires["r-teams-ch"];
  ok(ch.channel === teamsChannel, "teams: fires into the teams channel module");
  ok(
    ch.target["serviceUrl"] === "https://smba.trafficmanager.net/uk/" &&
      ch.target["conversationId"] === "19:eng@thread.tacv2" &&
      ch.target["conversationType"] === "channel" &&
      ch.target["tenantId"] === "TEN1",
    "teams: receive target carries the full conversation reference (serviceUrl/conversationId/scope/tenant)",
  );
  ok(ch.attributes["conversation_id"] === "19:eng@thread.tacv2" && ch.attributes["service_url"] === "https://smba.trafficmanager.net/uk/" && ch.attributes["tenant_id"] === "TEN1" && ch.attributes["scope"] === "channel", "teams: fire stamps conversation/service/tenant/scope for bindTeams");
  ok(ch.attributes["membership_type"] === undefined, "teams: NO membership_type is invented at fire time (trust fails closed to external)");
  const chBinding = bindFrom({ channel: { kind: "teams" }, session: { auth: { current: { attributes: ch.attributes } as never } } });
  ok(chBinding.workspace === "TEN1" && chBinding.surface === "19-eng-thread.tacv2", "teams: bindFrom re-derives the routine's REAL tenant/conversation partition (sanitized surface matches the surfaceKey)");
  ok(chBinding.mode === "channel" && chBinding.trust === "external", "teams: an unverified channel fire binds channel/external (fail-closed)");

  const dm = fires["r-teams-dm"];
  const dmBinding = bindFrom({ channel: { kind: "teams" }, session: { auth: { current: { attributes: dm.attributes } as never } } });
  ok(dmBinding.mode === "dm", "teams: a personal-chat fire binds dm mode (stored scope honoured)");
}

await seed({ id: "r-teams-noref", surfaceKey: "teams/TEN1/19-x", target: { conversationId: "19:x@thread.tacv2" } });
await seed({ id: "r-linear", surfaceKey: "linear/W1/T1", target: { agentSessionId: "AS1" } });
{
  const started = await tickCapture();
  ok(!started.includes("r-teams-noref") && !started.includes("r-linear"), "dry-run: unresolvable targets start NO session (fail-closed, no crash)");
  for (const id of ["r-teams-noref", "r-linear"] as const) {
    const surfaceKey = id === "r-teams-noref" ? "teams/TEN1/19-x" : "linear/W1/T1";
    const after = await store.getRoutine("default", surfaceKey, id);
    ok(after?.nextRunAt === past, `dry-run: ${id} keeps its nextRunAt (stays due for when its target exists)`);
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ dispatch: ${passed} assertions passed`);
