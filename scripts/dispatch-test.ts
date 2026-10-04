import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { routineMarker, type Routine } from "@open-everywhere/core/agent/routines/routine.js";
import { WATCH_SILENCE_SENTINEL, WATCH_STATE_TOOL } from "@open-everywhere/core/agent/routines/watch.js";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/turn-delivery.js";
import { bindFrom, registerIdentityMapper, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import { registerConfig, getConfig } from "@open-everywhere/core/agent/access/config.js";
import { defineDomain, domainForChannel } from "@open-everywhere/core/agent/memory/domain.js";
import { registerSlackBridge } from "@open-everywhere/core/agent/channels/slack-bridge.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { removeTempDir } from "../packages/core/scripts/_temp-dir.js";

const SENTINEL_SLACK_CHANNEL = {} as never;
registerSlackBridge({
  form: async () => ({ ok: true, ts: "1700000000.0001" }),
  readCall: async () => {
    throw new Error("not wired in this test");
  },
  fetchUserDisplayName: async () => undefined,
  fetchChannelDisplayName: async () => undefined,
  botDisplayName: async () => undefined,
  confirmChannelInternal: async () => false,
  partnerFactsFromInfo: () => ({ dmPartnerTrust: "external" }),
  channel: SENTINEL_SLACK_CHANNEL,
});
registerIdentityMapper("slack", (c) => {
  const a = (c.session?.auth?.current?.attributes ?? {}) as Record<string, string>;
  const channelId = a["channel_id"];
  const confirmedInternal = a["is_ext_shared"] === "false" && a["trust_checked"] === "true";
  return {
    workspace: a["team_id"],
    surface: channelId,
    mode: "channel",
    trust: confirmedInternal ? "internal" : "external",
    principalId: c.session?.auth?.current?.principalId || a["user_id"] || undefined,
    target: channelId ? { channelId } : undefined,
  };
});

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-dispatch-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
overrideSettingsForTest({ routines: { maxConcurrency: 2 } });

const store = await import("@open-everywhere/core/agent/routines/store.js");
const dispatch = await import("@open-everywhere/core/agent/schedules/dispatch.js");

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

const pendingDeliveries: Promise<unknown>[] = [];
const collectWaitUntil = (p: Promise<unknown>): void => void pendingDeliveries.push(p);
async function drainDeliveries(): Promise<void> {
  await Promise.allSettled(pendingDeliveries.splice(0));
}

const firedMessages: Record<string, string> = {};
async function tick(): Promise<string[]> {
  const started: string[] = [];
  const receive = (() => ({
    send: (message: string, opts: { auth?: { attributes?: Record<string, unknown> } }) => {
      const mk = routineMarker(opts.auth?.attributes as never);
      if (mk) {
        started.push(mk.id);
        firedMessages[mk.id] = message ?? "";
      }
      return Promise.resolve();
    },
  })) as never;
  const pending: Promise<unknown>[] = [];
  const args = {
    now,
    to: receive,
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    appAuth: { attributes: {} } as never,
  };
  await dispatch.dispatchTick(args as never);
  await Promise.allSettled(pending);
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

  const onceMidFlight = await store.getRoutine("default", "slack/T1/C1", "r-once");
  ok(onceMidFlight?.status === "active" && onceMidFlight?.nextRunAt === null, "OPE-506: right after a successful delivery the row is briefly still `active` (with no next run) — not yet terminal, because the outcome is not yet known");

  const { foldRoutineOutcome } = await import("@open-everywhere/core/agent/routines/outcome-fold.js");
  const folded = await foldRoutineOutcome({ marker: { id: "r-once", surfaceKey: "slack/T1/C1", org: "default" }, sessionOutcome: "ok", at: new Date("2026-07-02T12:00:00.000Z"), sessionId: "sess-once" });
  ok(folded.folded && folded.outcome === "ok", "the session settles ok, same as any other successful fire");

  const onceAfter = await store.getRoutine("default", "slack/T1/C1", "r-once");
  ok(onceAfter?.status === "disabled", "OPE-506: a fired once routine goes terminal once its outcome is known (not deleted — kept for list/audit visibility)");
  ok(onceAfter?.disabledReason?.includes("once: fired and ok at") === true, "OPE-506: the reason names the actual outcome (fired and ok), not a bare fired-at marker a failure could never overwrite");
  ok(onceAfter?.nextRunAt === null, "a fired once routine's nextRunAt goes to null (no next occurrence, ever)");
  ok(onceAfter?.trigger.kind === "once" && (onceAfter.trigger as { at: string }).at === "2026-07-02T11:55:00.000Z", "the once trigger's `at` is untouched by firing");

  ok(!(await tick()).includes("r-once"), "a fired once routine never fires again on a later tick");

  const { describeTrigger } = await import("@open-everywhere/core/agent/routines/routine.js");
  ok(describeTrigger(onceAfter!.trigger) === "once at 2026-07-02T11:55:00.000Z (fires once, then disables)", "describeTrigger renders the once trigger sensibly");
}

const opStore = (await import("@open-everywhere/core/agent/operational/provider.js")).getOperationalStore();
await opStore.setSpendLimit("default", "slack/T1/C2", "surface", { monthlyTokens: 100 });
await opStore.recordSpend("default", { surfaceKey: "slack/T1/C2", period: "2026-07", inputTokens: 90, outputTokens: 20 });

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

const testDomains = [defineDomain({ name: "watched", reach: ["slack/T9/C9"] })];
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
const captureReceive = (() => ({
  send: (_message: string, opts: { auth?: { attributes?: Record<string, unknown> } }) => {
    const mk = routineMarker(opts.auth?.attributes as never);
    if (mk?.id === "r-surface") capturedAuth = (opts.auth ?? null) as never;
    return Promise.resolve();
  },
})) as never;
await dispatch.dispatchTick({
  now,
  to: captureReceive,
  waitUntil: collectWaitUntil,
  appAuth: { attributes: {} } as never,
  confirmInternal: async () => true,
} as never);
await drainDeliveries();

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
  to: captureReceive,
  waitUntil: collectWaitUntil,
  appAuth: { attributes: {} } as never,
  confirmInternal: async () => false,
} as never);
await drainDeliveries();
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

const discordChannel = (await import("@open-everywhere/provider-discord/agent/channels/discord.js")).default;

interface CapturedFire {
  readonly channel: unknown;
  readonly target: Record<string, unknown>;
  readonly attributes: Record<string, unknown>;
}
const fires: Record<string, CapturedFire> = {};
async function tickCapture(): Promise<string[]> {
  const started: string[] = [];
  const receive = ((channel: unknown, target: Record<string, unknown> | undefined) => ({
    send: (_message: string, opts: { auth?: { attributes?: Record<string, unknown> } }) => {
      const mk = routineMarker(opts.auth?.attributes as never);
      if (mk) {
        started.push(mk.id);
        fires[mk.id] = { channel, target: target ?? {}, attributes: opts.auth?.attributes ?? {} };
      }
      return Promise.resolve();
    },
  })) as never;
  for (let i = 0; i < 10; i++) {
    const before = started.length;
    await dispatch.dispatchTick({
      now,
      to: receive,
      waitUntil: collectWaitUntil,
      appAuth: { attributes: {} } as never,
      confirmInternal: async () => true,
    } as never);
    await drainDeliveries();
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

{
  const { resolveDiscordTarget } = await import("@open-everywhere/provider-discord/agent/channels/discord-dispatch-target.js");
  const { planFireWindow } = await import("@open-everywhere/core/agent/routines/fire-window.js");
  const { isThreadSeatWindowToken } = await import("@open-everywhere/core/agent/channels/window-key.js");
  overrideSettingsForTest({ window: { topology: true } });
  const windowedDomain = defineDomain({ name: "discord-win", reach: ["discord/G3/CH3"], ambientSupervisor: true, mode: "unified" });

  const guildRoutine: Routine = {
    id: "r-dc-window",
    org: "default",
    surfaceKey: "discord/G3/CH3",
    target: { channelId: "CH3", guildId: "G3", channelType: "0" },
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: "digest",
    createdAt: now.toISOString(),
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: past,
  };
  const guildTarget = resolveDiscordTarget(guildRoutine);
  ok(guildTarget !== null, "OPE-486/discord: a guild routine still resolves a DispatchTarget");
  ok(guildTarget!.origin !== undefined, "OPE-486/discord: the DispatchTarget now carries an origin — pre-fix this field was always undefined");
  ok(
    guildTarget!.origin?.platform === "discord" &&
      (guildTarget!.origin as { channelId: string }).channelId === "CH3" &&
      (guildTarget!.origin as { guildId?: string }).guildId === "G3",
    "OPE-486/discord: the origin names the routine's real guild/channel",
  );

  const guildPlan = planFireWindow({ surfaceKey: "discord/G3/CH3", origin: guildTarget!.origin!, seatKey: "run/dc-1", domains: [windowedDomain], generation: 1, armed: true });
  ok(guildPlan !== null, "OPE-486/discord: a guild fire's origin is enough to take the divert path — pre-fix it never was");
  ok(isThreadSeatWindowToken(guildPlan!.token), "OPE-486/discord: the diverted fire's window token is a thread-seat token, same shape a Slack fire's divert mints");

  const noOriginPlan = planFireWindow({ surfaceKey: "discord/G3/CH3", origin: undefined as never, seatKey: "run/dc-1", domains: [windowedDomain], generation: 1, armed: true });
  ok(noOriginPlan === null, "OPE-486/discord NEGATIVE CONTROL: with no origin (the pre-fix state) the divert never applies, even on an otherwise-windowed surface");

  const dmRoutine: Routine = { ...guildRoutine, id: "r-dc-dm-window", surfaceKey: "discord/U9/D9", target: { channelId: "D9", channelType: "1" } };
  const dmTarget = resolveDiscordTarget(dmRoutine);
  ok(
    (dmTarget!.origin as { dm?: true } | undefined)?.dm === true && (dmTarget!.origin as { guildId?: string }).guildId === undefined,
    "OPE-486/discord: a DM fire's origin is the dm:true variant, never a guild-shaped origin with an empty guildId",
  );

  const legacyDmRoutine: Routine = { ...guildRoutine, id: "r-dc-legacy-dm", surfaceKey: "discord/U9/D9", target: { channelId: "D9" } };
  const legacyDmTarget = resolveDiscordTarget(legacyDmRoutine);
  ok(legacyDmTarget !== null, "OPE-503/discord: a legacy DM-shaped target still resolves a DispatchTarget (fires natively)");
  ok(
    legacyDmTarget!.origin === undefined,
    "OPE-503/discord: a legacy DM-shaped target (no channelType, no stored guildId) mints NO origin — refusing to guess beats minting a guild-shaped origin from the partner's user id",
  );

  const legacyGuildRoutine: Routine = { ...guildRoutine, id: "r-dc-legacy-guild-evidence", surfaceKey: "discord/G2/CH2", target: { channelId: "CH2", channelType: "0" } };
  const legacyGuildTarget = resolveDiscordTarget(legacyGuildRoutine);
  ok(
    legacyGuildTarget!.origin !== undefined && (legacyGuildTarget!.origin as { guildId?: string }).guildId === "G2",
    "OPE-503/discord NEGATIVE CONTROL: a channelType-evidenced guild row still mints its guild origin — the fix narrows on missing evidence, not on mode alone",
  );

  overrideSettingsForTest({ window: { topology: false } });
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

{
  type SpendBudgets = import("@open-everywhere/core/agent/spend/spend.js").SpendBudgets;
  const domains275 = [...testDomains, defineDomain({ name: "dm-crit", match: "dm" })];
  const budgets275: SpendBudgets = { perDomain: { "dm-crit": { surfaceMonthlyTokens: 50 } } };
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains275,
    loadSilos: () => [],
    domainsForSurface: (p) => {
      const d = domainForChannel(`${p.workspaceKey}/${p.surface}`, domains275);
      return d ? [d.name] : [];
    },
    loadSpendBudgets: () => budgets275,
  });
  await opStore.recordSpend("default", { surfaceKey: "slack/T1/D_CREATOR", period: "2026-07", inputTokens: 60, outputTokens: 0 });
  const mkDm = (id: string, surface: string, createdBy: string): Routine => ({
    id,
    org: "default",
    surfaceKey: `slack/T1/${surface}`,
    trigger: { kind: "interval", everyMinutes: 30 },
    prompt: "morning brief",
    createdAt: now.toISOString(),
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: past,
    target: { channelId: surface },
    createdBy,
  });
  await store.addRoutine({} as never, mkDm("r-dm-capped", "D_CREATOR", "U_CREATOR"));
  await store.addRoutine({} as never, mkDm("r-dm-under", "D_OTHER", "U_OTHER"));
  {
    const started: string[] = [];
    const receive = (() => ({
      send: (_message: string, opts: { auth?: { attributes?: Record<string, unknown> } }) => {
        const mk = routineMarker(opts.auth?.attributes as never);
        if (mk) started.push(mk.id);
        return Promise.resolve();
      },
    })) as never;
    await dispatch.dispatchTick({
      now,
      to: receive,
      waitUntil: collectWaitUntil,
      appAuth: { attributes: {} } as never,
      confirmCreatorInternal: async () => true,
    } as never);
    await drainDeliveries();
    ok(!started.includes("r-dm-capped"), 'OPE-275: perDomain["dm"] ALONE declines a DM cron fire — the recommended "everyone gets their own budget" config now binds the unattended leg too');
    ok(started.includes("r-dm-under"), "OPE-275: …and it is the BUDGET declining, not the DM shape — a second, under-budget DM fires on the same tick under the same config");
    const after = await store.getRoutine("default", "slack/T1/D_CREATOR", "r-dm-capped");
    ok(after?.lastOutcome === "skipped", "OPE-275: the dm-criteria decline records `skipped` and advances, exactly like every other budget decline");
    ok(after?.nextRunAt !== null && after?.nextRunAt !== undefined && Date.parse(after.nextRunAt) > now.getTime(), "OPE-275: …schedule advanced (retries at its cadence, not every tick)");
  }
}

await removeTempDir(dir);
console.log(`✓ dispatch: ${passed} assertions passed`);
