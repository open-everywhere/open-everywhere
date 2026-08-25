import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { overrideSettingsForTest } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-triggered-fire-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
overrideSettingsForTest({ delegation: { oneshotAgent: false } });
overrideSettingsForTest({ window: { topology: true } });

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const fireWindow = await import("../agent/routines/fire-window.js");
const { classifySessionId, isThreadSeatWindowToken, parseWindowToken } = await import("../agent/channels/window-key.js");
const { standingSeatRegistryKey, unifiedDomainSessionKey, unifiedWindowFromToken } = await import("../agent/channels/unified-supervisor.js");
const { claimRuntimeRotation, RUNTIME_ROTATION_AUDIT_ACTION } = await import("../agent/channels/runtime-rotation.js");
const { windowGrainOf } = await import("../agent/identity/binding.js");
const { fullKit, WINDOW_GATED_TOOLS, memoryRecallRouteFor } = await import("../agent/access/window-gate-manifest.js");
const { OE_GRAIN_ATTR, OE_ADDRESSING_ATTR, resolveAnswerableReplyTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { OE_REQUESTER_ATTR, OE_REQUESTER_CANDIDATES_ATTR, REQUESTER_UNVERIFIED } = await import("../agent/access/requester-identity.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { ROUTINE_MARKER, routineMarker } = await import("../agent/routines/routine.js");
const { WEBHOOK_MARKER_ATTR, webhookFireAttributes } = await import("../agent/routines/fire-auth.js");
const { NO_REPLY_SENTINEL } = await import("../agent/channels/normalized-wake.js");
const unifiedMod = await import("../agent/channels/unified.js");
const unifiedChannel = unifiedMod.default;

type Routine = import("../agent/routines/routine.js").Routine;
type UnifiedWakeOrigin = import("../agent/channels/unified-window.js").UnifiedWakeOrigin;
type UnifiedReceiveTarget = import("../agent/channels/unified.js").UnifiedReceiveTarget;
type Domain = import("../agent/memory/domain.js").Domain;

const ORG = "default";
const DOMAIN = "payments";
const TEAM = "T_FIRE";
const CHAN = "C_FIRE";
const SURFACE = `slack/${TEAM}/${CHAN}`;
const LONELY_SURFACE = "slack/T_FIRE/C_LONELY";
const HEAL_DOMAIN = "treasury";
const HEAL_CHAN = "C_HEAL";
const HEAL_SURFACE = `slack/${TEAM}/${HEAL_CHAN}`;
const ROTA_DOMAIN = "logistics";
const ROTA_CHAN = "C_ROTA";
const ROTA_SURFACE = `slack/${TEAM}/${ROTA_CHAN}`;

const SLACK_CHANNEL = { __fixture: "slack" } as never;
registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => true });
registerSlackFixtureCodec();
registerSlackFixtureMapper();

const winDomain = defineDomain({ name: DOMAIN, channels: [SURFACE], ambientSupervisor: true, mode: "unified" });
const healDomain = defineDomain({ name: HEAL_DOMAIN, channels: [HEAL_SURFACE], ambientSupervisor: true, mode: "unified" });
const rotaDomain = defineDomain({ name: ROTA_DOMAIN, channels: [ROTA_SURFACE], ambientSupervisor: true, mode: "unified" });
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [winDomain, healDomain, rotaDomain],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) =>
    surface === CHAN ? [DOMAIN] : surface === HEAL_CHAN ? [HEAL_DOMAIN] : surface === ROTA_CHAN ? [ROTA_DOMAIN] : [],
});
const DOMAINS: readonly Domain[] = [winDomain];

const SLACK_ORIGIN: UnifiedWakeOrigin = { platform: "slack", channelId: CHAN };
const store = getOperationalStore();

{
  const base = { surfaceKey: SURFACE, origin: SLACK_ORIGIN, seatKey: "run/abc", domains: DOMAINS, generation: 4, armed: true };
  const plan = fireWindow.planFireWindow(base);
  ok(plan !== null, "plan: an armed fire on a windowed surface DOES get a window (the whole defect: it never did)");
  ok(plan!.domain === DOMAIN, "plan: the window is anchored on the surface's domain");
  ok(parseWindowToken(plan!.token)?.generation === 4, "plan: the standing window's CURRENT generation rides into the token (a rotation retires fire seats too)");
  ok(plan!.token.includes(":win:s/"), "plan: the windowId is a THREAD-SEAT id (`s/…`) — not a task id, not the degenerate domain form");
  ok(isThreadSeatWindowToken(plan!.token), "plan: the minted token classifies as a thread-seat token");

  ok(classifySessionId(plan!.token).grain === "thread", "grain/token: the TOKEN SHAPE alone classifies the fire `thread` (the fail-closed backstop)");
  ok(classifySessionId(plan!.token).grain !== "task", "grain/token: an `s/` id can never fail OPEN to the one wide-hands grain");
  const noStampCtx = { channel: { continuationToken: plan!.token }, session: { auth: { current: { attributes: {} } } } } as never;
  ok(windowGrainOf(noStampCtx) === "thread", "grain/backstop: even with the host `oe_grain` stamp LOST, windowGrainOf still reads `thread` off the token");
  ok(fireWindow.TRIGGERED_FIRE_GRAIN === "thread", "grain: the constant every ingress stamps is `thread`");

  ok(fireWindow.planFireWindow({ ...base, armed: false }) === null, "plan/fail-closed: delegation DISARMED ⇒ no divert (flag-off is byte-identical; a thread seat with no delegator would be worse than native)");
  ok(fireWindow.planFireWindow({ ...base, surfaceKey: LONELY_SURFACE }) === null, "plan/fail-closed: a surface with no window ⇒ no divert");
  ok(fireWindow.planFireWindow({ ...base, domains: [] }) === null, "plan/fail-closed: no domains configured ⇒ no divert");
  ok(fireWindow.planFireWindow({ ...base, seatKey: "" }) === null, "plan/fail-closed: an empty seat key ⇒ no divert");
  ok(
    fireWindow.planFireWindow({ ...base, origin: { platform: "teams", serviceUrl: "https://smba.trafficmanager.net/", conversationId: "c1" } }) === null,
    "plan/fail-closed: an origin whose platform has NO registered wake-origin codec ⇒ no divert (a wake we could never reply from is not dispatched)",
  );
  ok(
    fireWindow.planFireWindow({ ...base, origin: { platform: "slack", channelId: "" } }) === null,
    "plan/fail-closed: a structurally invalid origin is rejected by isUnifiedWakeOrigin",
  );

  ok(fireWindow.jobFireSeatKey("r-1") === fireWindow.jobFireSeatKey("r-1"), "seat/job: STABLE per routine — a durable job resumes ONE seat across fires (the OPE-55 join, now token-derived)");
  ok(fireWindow.runFireSeatKey("w-1") !== fireWindow.runFireSeatKey("w-2"), "seat/run: UNIQUE per fire — a non-job run gets its own session, exactly as before");
  ok(!fireWindow.jobFireSeatKey("a:b").includes(":"), "seat: colons are sanitised (a windowId is `[^:]+`)");
  ok(
    fireWindow.planFireWindow({ ...base, seatKey: fireWindow.jobFireSeatKey("r-1") })!.token ===
      fireWindow.planFireWindow({ ...base, seatKey: fireWindow.jobFireSeatKey("r-1") })!.token,
    "seat/job: the same job seat key mints the SAME token ⇒ eve resumes the SAME session",
  );

  ok(fireWindow.isJobFireSeat(fireWindow.jobFireSeatKey("r-1")), "seat/kind: a job seat key classifies as a job seat");
  ok(!fireWindow.isJobFireSeat(fireWindow.runFireSeatKey("w-1")), "seat/kind: a run seat key does NOT classify as a job seat");
  const jobToken = fireWindow.planFireWindow({ ...base, seatKey: fireWindow.jobFireSeatKey("r-1") })!.token;
  const runToken = fireWindow.planFireWindow({ ...base, seatKey: fireWindow.runFireSeatKey("w-1") })!.token;
  ok(!fireWindow.isRunFireSeatWindowId(unifiedWindowFromToken(jobToken)!), "seat/kind: a job seat's windowId does NOT read as a run-seat windowId");
  ok(fireWindow.isRunFireSeatWindowId(unifiedWindowFromToken(runToken)!), "seat/kind: a run seat's windowId DOES read as a run-seat windowId — the spend-hook warning's suppression key");
  ok(!fireWindow.isRunFireSeatWindowId(DOMAIN), "seat/kind: a plain (non-seat) windowId never false-positives as a run seat");
}

{
  interface Row {
    token: string;
    generation: number;
    turnCount: number;
  }
  function mockStore(initial: Row | undefined) {
    let row = initial;
    const calls: string[] = [];
    return {
      calls,
      row: () => row,
      store: {
        async getChannelSession() {
          return row ? { org: "o", surfaceKey: "k", createdAt: "t", lastWakeAt: "t", inputTokensTotal: 0, firstWakeAt: null, lastInputTokens: null, ...row } : null;
        },
        async rotateChannelSession(_org: string, _key: string, newToken: string) {
          calls.push("rotate");
          row = { token: newToken, generation: (row?.generation ?? 0) + 1, turnCount: 0 };
          return { org: "o", surfaceKey: "k", createdAt: "t", lastWakeAt: "t", inputTokensTotal: 0, firstWakeAt: null, handoffNote: null, ...row };
        },
        async touchChannelSession() {
          calls.push("touch");
          if (row) row = { ...row, turnCount: row.turnCount + 1 };
        },
      } as never,
    };
  }

  {
    const m = mockStore(undefined);
    await fireWindow.adoptJobFireSeat("o", "oe-domain::s/x/job/r-1", "tok-g1", "2026-08-08T00:00:00.000Z", m.store);
    ok(m.calls.length === 1 && m.calls[0] === "rotate", "adopt/new: no existing row ⇒ ADOPT via rotateChannelSession, not touch");
    ok(m.row()?.token === "tok-g1" && m.row()?.generation === 1, "adopt/new: the row is minted at generation 1 with the fire's token");
  }

  {
    const m = mockStore({ token: "tok-g1", generation: 1, turnCount: 3 });
    await fireWindow.adoptJobFireSeat("o", "oe-domain::s/x/job/r-1", "tok-g1", "2026-08-08T00:01:00.000Z", m.store);
    ok(m.calls.length === 1 && m.calls[0] === "touch", "adopt/resume: the SAME token ⇒ RESUME via touchChannelSession, no rotation");
    ok(m.row()?.turnCount === 4, "adopt/resume: turnCount increments — the backstop counter finally accrues for a job seat");
    ok(m.row()?.generation === 1, "adopt/resume: generation is unchanged");
  }

  {
    const m = mockStore({ token: "tok-g1", generation: 1, turnCount: 40 });
    await fireWindow.adoptJobFireSeat("o", "oe-domain::s/x/job/r-1", "tok-g2", "2026-08-08T00:02:00.000Z", m.store);
    ok(m.calls.length === 1 && m.calls[0] === "rotate", "adopt/reheal: a stale stored token (parent window rotated) ⇒ RE-ADOPT via rotateChannelSession, self-healing the row to match reality");
    ok(m.row()?.token === "tok-g2" && m.row()?.generation === 2, "adopt/reheal: the row now tracks the fire's CURRENT token, and its own generation bookkeeping bumps");
    ok(m.row()?.turnCount === 0, "adopt/reheal: counters reset — the rotation IS reflected in the registry now, not just in the derived token");
  }

  {
    const angryStore = {
      async getChannelSession() {
        throw new Error("store down");
      },
      async rotateChannelSession() {
        throw new Error("unreachable");
      },
      async touchChannelSession() {
        throw new Error("unreachable");
      },
    } as never;
    await fireWindow.adoptJobFireSeat("o", "oe-domain::s/x/job/r-1", "tok-g1", "2026-08-08T00:03:00.000Z", angryStore);
    ok(true, "adopt/fail-safe: a store hiccup is swallowed — the fire must never be lost over registry bookkeeping");
  }
}

{
  const ARMED_KIT = ["task"] as const;
  ok(!ARMED_KIT.includes("thread" as never), "hands: a thread seat is NARROW — never the wide-hands kit (that stays the one-shot worker's)");
  ok(WINDOW_GATED_TOOLS["agent"].includes("thread"), "delegator: `agent` MOUNTS on thread grain — the fire can reach wider hands");
  ok(!WINDOW_GATED_TOOLS["agent"].includes("native"), "delegator: `agent` does NOT mount on native — which is why the pre-fix fire had none");
  ok(memoryRecallRouteFor("thread", ARMED_KIT, true) === "agent", "memory: a thread-grain fire reaches its org memory via `agent`");
  ok(memoryRecallRouteFor("native", ARMED_KIT, true) === "none", "memory/defect pinned: the grain the fire USED to land on could not reach memory at all");
  ok(Array.isArray(fullKit()), "hands: fullKit() is the single flag-derived lever both rows above read");
}

interface Delivered {
  readonly unified: boolean;
  readonly target: Record<string, unknown>;
  readonly message: string;
  readonly attrs: Record<string, unknown>;
  readonly continuationToken?: string;
}
function captureReceive() {
  const seen: Delivered[] = [];
  const to = ((channel: unknown, target: unknown) => ({
    send: async (message: string, options: { auth?: { attributes?: Record<string, unknown> } }) => {
      const unified = channel === (unifiedChannel as unknown);
      let continuationToken: string | undefined;
      if (unified) {
        await unifiedChannel.receive!({ message, target: target as never, auth: options.auth as never }, {
          from: ((address: string) => ({
            send: async () => {
              continuationToken = address;
              return {} as never;
            },
          })) as never,
          resolveSession: (async () => undefined) as never,
        });
      }
      seen.push({
        unified,
        target: (target ?? {}) as Record<string, unknown>,
        message,
        attrs: options.auth?.attributes ?? {},
        ...(continuationToken !== undefined ? { continuationToken } : {}),
      });
      return {} as never;
    },
  })) as never;
  return { seen, to };
}

const dispatch = await import("../agent/schedules/dispatch.js");
const routineStore = await import("../agent/routines/store.js");

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: CHAN },
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: "Post the daily digest.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

async function tick(now: Date, to: unknown, appAttrs: Record<string, unknown> = {}): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({
    now,
    to,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    appAuth: { attributes: appAttrs },
    postJobKickoff: async () => "1700000000.0001",
  } as never);
  await Promise.all(pending);
}

const NOW = new Date("2026-07-02T12:00:00.000Z");

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-clock" }));
  const { seen, to } = captureReceive();
  await tick(NOW, to);
  ok(seen.length === 1, "clock: exactly one delivery");
  const d = seen[0];
  ok(d.unified, "clock: the fire is delivered into the UNIFIED channel — it JOINS the window (pre-fix it went to the native provider channel)");
  const target = d.target as unknown as UnifiedReceiveTarget;
  ok(isThreadSeatWindowToken(target.token), "clock: the fire's window token is a THREAD-SEAT token");
  ok(d.continuationToken === target.token, "clock: the unified receive delivered under that exact raw token (one token ⇒ one session)");
  ok(d.attrs[OE_GRAIN_ATTR] === "thread", "clock: the delivery carries the host-set `oe_grain: thread` stamp");
  ok(d.attrs[OE_ADDRESSING_ATTR] === "direct-mention", "clock: the fire is OWED its output — addressed, so terminal prose bridges to the origin instead of being hard-dropped");
  ok(routineMarker(d.attrs as never)?.id === "r-clock", "clock: the ROUTINE MARKER still rides the fire (the OPE-145 outcome/forensics join is unmoved)");
  ok(d.attrs["channel_id"] === CHAN && d.attrs["team_id"] === TEAM, "clock: the platform identity attributes still ride (partition/spend binding unmoved)");
  ok(d.attrs["trust_checked"] === "true", "clock: the LIVE per-fire trust recheck still rides");
  ok(d.attrs[OE_REQUESTER_ATTR] === REQUESTER_UNVERIFIED, "clock: the fire stamps `oe_requester: oe/unverified` — a fire names no asker, out loud");
  ok(d.attrs[OE_REQUESTER_CANDIDATES_ATTR] === undefined, "clock: the fire carries NO candidate set — it names nobody, so the all-candidates rule must refuse it");

  const origin = await store.getUnifiedWakeTarget(ORG, target.wakeId);
  ok(origin !== null, "clock/ANSWERABLE: a durable `wakeId → origin` row exists (pre-fix this write never happened at all)");
  const resolved = await resolveAnswerableReplyTarget(store, ORG, target.wakeId, target.token, "turn-1", target.wakeId);
  ok(resolved.ok && resolved.origin.platform === "slack", "clock/ANSWERABLE: the unified `reply` fence RESOLVES the fire's own wake to its origin");
  ok(resolved.ok && (resolved.origin as { channelId: string }).channelId === CHAN, "clock/ANSWERABLE: it resolves to the channel the routine posts in");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-clock");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-stale-candidates" }));
  const { seen, to } = captureReceive();
  await tick(NOW, to, { [OE_REQUESTER_CANDIDATES_ATTR]: JSON.stringify(["U_ORG_A", "U_ORG_B"]), oe_unrelated_probe: "kept" });
  ok(seen.length === 1 && seen[0].unified, "stale-candidates: the fire still diverts into the window (the leg is exercising the divert path)");
  ok(
    seen[0].attrs[OE_REQUESTER_CANDIDATES_ATTR] === undefined,
    "🔴 stale-candidates: a candidate list already in the forwarded app bag is DELETED — a fire may never be served on another turn's askers",
  );
  ok(
    seen[0].attrs[OE_REQUESTER_ATTR] === REQUESTER_UNVERIFIED,
    "…while the who-asked stamp beside it is still written, so the refusal stays honest rather than silent",
  );
  ok(
    seen[0].attrs["oe_unrelated_probe"] === "kept",
    "negative control: an unrelated forwarded attribute DOES survive the fire, so the delete above is targeted rather than a bag that drops everything",
  );
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-stale-candidates");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: false } });
  await routineStore.addRoutine({} as never, routine({ id: "r-off" }));
  const { seen, to } = captureReceive();
  await tick(NOW, to);
  ok(seen.length === 1 && !seen[0].unified, "flag-off: the fire lands NATIVE — delegation disarmed means a thread seat would have no delegator, so the divert must not apply");
  ok(seen[0].target["channelId"] === CHAN && seen[0].target["threadTs"] === undefined, "flag-off: the native target is unchanged");
  ok(seen[0].attrs[OE_GRAIN_ATTR] === undefined, "flag-off: no window stamps are added — byte-identical to the pre-OPE-144 fire");
  ok(seen[0].attrs[OE_REQUESTER_ATTR] === undefined, "flag-off: the who-asked stamp is absent too — the native fire is byte-identical, and its seat classifies `open` where `none` is the honest answer");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-off");

  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-lonely", surfaceKey: LONELY_SURFACE, target: { channelId: "C_LONELY" } }));
  const l = captureReceive();
  await tick(NOW, l.to);
  ok(l.seen.length === 1 && !l.seen[0].unified, "no-window: a surface outside every windowed domain keeps the native fire (fail-closed to today's behaviour)");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: LONELY_SURFACE } as never, "r-lonely");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-job", sessionMode: "job", trigger: { kind: "interval", everyMinutes: 1 } }));
  const a = captureReceive();
  await tick(NOW, a.to);
  const t1 = a.seen[0].target as unknown as UnifiedReceiveTarget;
  ok(a.seen[0].unified, "job: a durable-job fire joins the window too");
  ok((t1.origin as { threadTs?: string }).threadTs === "1700000000.0001", "job: the wake ORIGIN is the job's own thread anchor — its answers land in the job thread, not the channel root");

  const jobRegistryKey = standingSeatRegistryKey(t1.token, DOMAIN)!;
  ok(jobRegistryKey.startsWith("oe-domain::s/") && jobRegistryKey.includes("/job/"), "job/registry: the derived key IS the job-seat-shaped synthetic key (not the parent window's own row)");
  const row1 = await store.getChannelSession(ORG, jobRegistryKey);
  ok(row1 !== null, "job/registry: a row now EXISTS after the job's first fire — pre-OPE-341 this was permanently null");
  ok(row1?.token === t1.token, "job/registry: the row's token is the fire's OWN dispatched token, so bumpChannelSessionUsage's token guard matches it");
  ok(row1?.turnCount === 0, "job/registry: ADOPT mints at turnCount 0 (rotateChannelSession's reset semantics)");

  const bumped = await store.bumpChannelSessionUsage(ORG, jobRegistryKey, t1.token, 12_345);
  ok(bumped === 1, "job/registry: bumpChannelSessionUsage MATCHES the job seat's row (was a guaranteed 0-row no-op before this ticket)");
  const row1b = await store.getChannelSession(ORG, jobRegistryKey);
  ok(row1b?.inputTokensTotal === 12_345, "job/registry: the token-budget counter actually accrues real data for a job seat");

  const b = captureReceive();
  await tick(new Date(NOW.getTime() + 10 * 60_000), b.to);
  const t2 = b.seen[0].target as unknown as UnifiedReceiveTarget;
  ok(t2.token === t1.token, "job: the SECOND fire resumes the SAME seat token — the OPE-55 durable-job session join survives the re-grain");
  ok(t2.wakeId !== t1.wakeId, "job: each fire still mints its OWN wakeId (two runs, two answerable wakes, one session)");

  const row2 = await store.getChannelSession(ORG, jobRegistryKey);
  ok(row2?.turnCount === 1, "job/registry: the turn-count BACKSTOP now accrues too (touchChannelSession finally reaches a job seat)");
  ok(row2?.token === t1.token, "job/registry: the row's token is unchanged (same generation — the parent window did not rotate between the two fires)");
  ok(row2?.inputTokensTotal === 12_345, "job/registry: RESUME does not reset counters — only a RE-ADOPT (an actual parent-window rotation) does");

  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-job");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-run-only" }));
  const a = captureReceive();
  await tick(NOW, a.to);
  const t1 = a.seen[0].target as unknown as UnifiedReceiveTarget;
  ok(a.seen[0].unified, "run: a plain (non-job) fire still joins the window");
  const runRegistryKey = standingSeatRegistryKey(t1.token, DOMAIN)!;
  ok(runRegistryKey.startsWith("oe-domain::s/") && runRegistryKey.includes("/run/"), "run/registry: the derived key IS the run-seat-shaped synthetic key");
  const runRow = await store.getChannelSession(ORG, runRegistryKey);
  ok(runRow === null, "run/registry: NO row is created for a run seat — by design, unlike a job seat");
  const runBump = await store.bumpChannelSessionUsage(ORG, runRegistryKey, t1.token, 999);
  ok(runBump === 0, "run/registry: bumpChannelSessionUsage genuinely misses (0 rows) — the exact case the spend-hook warning suppression exists for");
  ok(isRunFireSeatWindowIdCheck(unifiedWindowFromToken(t1.token)), "run/registry: and the windowId is recognised as a run seat by the same predicate the spend hook consults");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-run-only");
}
function isRunFireSeatWindowIdCheck(windowId: string | undefined): boolean {
  return windowId !== undefined && fireWindow.isRunFireSeatWindowId(windowId);
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-lost" }));
  const before = (await readAudit({ org: ORG, limit: 200 })).length;
  const boom = (() => ({
    send: async () => {
      throw new Error("divert exploded");
    },
  })) as never;
  await tick(NOW, boom);
  const rows = await readAudit({ org: ORG, limit: 200 });
  const lost = rows.filter((r) => r.action === "routine.fire_lost" && (r.detail as { routineId?: string } | undefined)?.routineId === "r-lost");
  ok(rows.length > before, "forensics: the failed fire wrote an audit row");
  ok(lost.length === 1, "forensics: a failed DIVERT lands the SAME `routine.fire_lost` row a failed native receive does — the trail does not move when the grain does");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-lost");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  const { fanOutDelivery } = await import("../agent/routines/github-fanout.js");
  const { registerEntityRead } = await import("../agent/routines/entity-read.js");
  registerEntityRead({ platform: "github", read: async () => ({ status: "gone" }) });
  const GRANT = { resolve: () => ({ repos: ["me/proj"] }) as never };
  const ev = routine({ id: "r-event", trigger: { kind: "event", source: "github" }, prompt: "Summarise the PR." });
  const body = JSON.stringify({
    action: "opened",
    pull_request: { number: 42, title: "Add caching", html_url: "https://github.com/me/proj/pull/42" },
    repository: { full_name: "me/proj" },
    sender: { login: "alice" },
  });
  const { seen, to } = captureReceive();
  await fanOutDelivery(body, "pull_request", "delivery-1", { to, org: ORG, listRoutines: async () => [ev], grant: GRANT });
  ok(seen.length === 1 && seen[0].unified, "event: an event-routine fire joins the window on the SAME decision as a clock fire");
  ok(seen[0].attrs[OE_GRAIN_ATTR] === "thread", "event: thread grain");
  ok(routineMarker(seen[0].attrs as never)?.id === "r-event", "event: the routine marker still rides");
  const et = seen[0].target as unknown as UnifiedReceiveTarget;
  ok((await store.getUnifiedWakeTarget(ORG, et.wakeId)) !== null, "event/ANSWERABLE: the `wakeId → origin` row is registered");

  overrideSettingsForTest({ delegation: { oneshotAgent: false } });
  const off = captureReceive();
  await fanOutDelivery(body, "pull_request", "delivery-2", { to: off.to, org: ORG, listRoutines: async () => [ev], grant: GRANT });
  ok(off.seen.length === 1 && !off.seen[0].unified, "event/flag-off: byte-identical native fire");
}

{
  const { defineWebhook, assertWebhooksValid } = await import("../agent/webhooks/config.js");
  const { fireWebhook } = await import("../agent/webhooks/dispatch.js");
  const hook = defineWebhook({
    id: "deploy-status",
    source: "oe-standard-webhook",
    secretRef: "DEPLOY_STATUS_WEBHOOK_SECRET",
    broker: "env",
    target: SURFACE,
    readableBy: [{ level: "domain", domain: "eng" }],
    instruction: "A deploy just finished. Summarise it.",
  });

  const bag = webhookFireAttributes("deploy-status", TEAM, CHAN, false, true);
  ok(bag[WEBHOOK_MARKER_ATTR] === "deploy-status", "webhook/bag: the hook marker rides");
  ok(bag["team_id"] === TEAM && bag["channel_id"] === CHAN && bag["channel_type"] === "channel", "webhook/bag: the surface stamping is unchanged");
  ok(bag["trust_checked"] === "true", "webhook/bag: the live trust verdict rides, positive-only");
  ok(webhookFireAttributes("h", TEAM, "D_X", true, false)[OE_GRAIN_ATTR] === "standing", "webhook/bag: a DM-family target would stamp the standing grain — the shared builder can no longer omit a deliberate stamp");

  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  const { seen, to } = captureReceive();
  const res = await fireWebhook(hook, JSON.stringify({ status: "failed" }), { to, confirmInternal: async () => true });
  ok(res.fired, "webhook: the fire reports fired");
  ok(seen.length === 1 && seen[0].unified, "webhook: an unattended, PUBLICLY-triggered fire joins the window at thread grain — not the `native` posture a live human channel turn carries");
  ok(seen[0].attrs[OE_GRAIN_ATTR] === "thread", "webhook: thread grain (pre-fix this leg stamped NO grain attribute at all)");
  ok(seen[0].attrs[WEBHOOK_MARKER_ATTR] === "deploy-status", "webhook: the hook marker rides through the divert");
  ok(seen[0].attrs[ROUTINE_MARKER.id] === undefined, "webhook: a hook fire carries no routine marker (it is not a routine — the outcome hook stays a no-op)");
  const wt = seen[0].target as unknown as UnifiedReceiveTarget;
  ok(isThreadSeatWindowToken(wt.token), "webhook: a thread-seat token");
  const wres = await resolveAnswerableReplyTarget(store, ORG, wt.wakeId, wt.token, "turn-w", wt.wakeId);
  ok(wres.ok, "webhook/ANSWERABLE: the fire's wake resolves through the unified reply fence");
  ok(res.wakeId === wt.wakeId, "webhook/JOIN: the fire returns the SAME wake id the window registered — the handle the audit row carries");

  overrideSettingsForTest({ delegation: { oneshotAgent: false } });
  const off = captureReceive();
  const offRes = await fireWebhook(hook, JSON.stringify({ status: "ok" }), { to: off.to, confirmInternal: async () => true });
  ok(off.seen.length === 1 && !off.seen[0].unified, "webhook/flag-off: byte-identical native fire");
  ok(off.seen[0].target["channelId"] === CHAN, "webhook/flag-off: the native target is unchanged");
  ok(offRes.fired === true && offRes.wakeId === undefined, "webhook/flag-off: a NATIVE fire reports NO wake id — nothing carries it to the reply, so there is no join to claim");

  const dmHook = defineWebhook({
    id: "dm-hook",
    source: "oe-standard-webhook",
    secretRef: "DM_HOOK_SECRET",
    broker: "env",
    target: "slack/T_FIRE/D_ALICE",
    readableBy: [{ level: "domain", domain: "eng" }],
    instruction: "Ping me.",
  });
  assertWebhooksValid([dmHook]);
  const dm = captureReceive();
  await fireWebhook(dmHook, JSON.stringify({ ping: 1 }), { to: dm.to, confirmInternal: async () => false });
  ok(dm.seen.length === 1 && !dm.seen[0].unified, "webhook/dm: the DM hook fires (no window on that surface ⇒ the native path)");
  ok(dm.seen[0].attrs["channel_type"] === "im", "webhook/dm: the fire binds as a DM — it used to hardcode `channel` on a 1:1, mis-binding the session's mode");
  ok(dm.seen[0].attrs[OE_GRAIN_ATTR] === "standing", "webhook/dm: an autonomous fire into someone's DM gets the DM-family STANDING grain, NOT a live human turn's hands (the fourth site's real hole)");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  const w1 = mintWakeId();
  const w2 = mintWakeId();
  const base = { surfaceKey: SURFACE, origin: SLACK_ORIGIN, domains: DOMAINS, generation: 1, armed: true };
  const p1 = fireWindow.planFireWindow({ ...base, seatKey: fireWindow.runFireSeatKey(w1) });
  const p2 = fireWindow.planFireWindow({ ...base, seatKey: fireWindow.runFireSeatKey(w2) });
  ok(p1!.token !== p2!.token, "runs: two non-job fires mint DIFFERENT seats ⇒ a fresh session per run, exactly as before the re-grain");
  ok(classifySessionId(p1!.token).grain === "thread" && classifySessionId(p2!.token).grain === "thread", "runs: both are thread grain");
}

{
  const { registerSlackFixturePostArm } = await import("./_slack-test-stubs.js");
  const { OE_WAKE_ID_ATTR, shouldBridgeAddressedProse } = await import("../agent/channels/unified-window.js");
  const { replayStepNames } = await import("../agent/access/window-gated.js");

  const posted: { channel: string; text: string }[] = [];
  registerSlackTestBridge({
    confirmChannelInternal: async () => true,
    form: async (method: string, body: string) => {
      const p = new URLSearchParams(body);
      if (method === "chat.postMessage") posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
      return { ok: true, ts: "1700000001.0001" } as never;
    },
  });
  registerSlackFixturePostArm();

  const wakeIdInMessage = (message: string): string | undefined =>
    /`wake-id` for this fire is `([^`]+)`/.exec(message)?.[1];

  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-speak", prompt: "Post the deploy digest." }));
  const { seen, to } = captureReceive();
  await tick(NOW, to);
  ok(seen.length === 1 && seen[0].unified, "speak: the fire diverted (the precondition for everything below)");
  const d = seen[0];
  const target = d.target as unknown as UnifiedReceiveTarget;

  const disclosed = wakeIdInMessage(d.message);
  ok(disclosed !== undefined, "speak/DISCLOSURE: the fire's message names a `wake-id` — pre-fix it named none, which is why prod hallucinated one");
  ok(disclosed === target.wakeId, "speak/DISCLOSURE: the id in the message is the SAME id the durable map row was registered under (one binding, two consumers)");
  ok(d.attrs[OE_WAKE_ID_ATTR] === disclosed, "speak/DISCLOSURE: and the same id the host stamped on the delivery, so the bridge and the tool agree");
  ok(d.message.includes("Post the deploy digest."), "speak: the routine's own prompt still rides verbatim");
  ok(!d.message.includes("<untrusted_external_data"), "speak: the mandate does not re-wrap the fire prompt as untrusted (it is appended, never around)");

  const resolved = await resolveAnswerableReplyTarget(store, ORG, disclosed ?? "none", target.token, "turn-speak", disclosed ?? "none");
  ok(resolved.ok, "speak/REPLY: the id the model can READ OFF ITS OWN MESSAGE is accepted by the answerable-reply fence");
  ok(resolved.ok && (resolved.origin as { channelId: string }).channelId === CHAN, "speak/REPLY: and it resolves to the room the routine posts in");

  await import("../agent/tools/reply.js");
  const reg = (globalThis as Record<symbol, unknown>)[Symbol.for("@workflow/core//registeredSteps")] as Map<string, unknown>;
  const replyExec = reg?.get(replayStepNames("reply", "_single").execute) as
    | ((cv: unknown, input: unknown, ctx: unknown) => Promise<unknown>)
    | undefined;
  ok(typeof replyExec === "function", "speak/ROOM: the unified `reply` execute is reachable (the only way to speak in this window)");
  const ctx = {
    session: { auth: { current: { attributes: d.attrs } }, turn: { id: "turn-speak" } },
    channel: { continuationToken: target.token },
  };
  const out = await replyExec!({}, { text: "Deploy 42 is green.", wake: disclosed ?? "made-up", done: true }, ctx)
    .then((r) => r as { posted?: boolean })
    .catch(() => ({ posted: false }));
  ok(out.posted === true, "speak/ROOM: `reply` ACCEPTED the disclosed id and posted — pre-fix the model had no id, guessed, and was refused");
  ok(posted.length === 1, "speak/ROOM: the fire's output actually LANDED — one post reached the surface (the regression: nothing landed at all)");
  ok(posted[0].channel === CHAN && posted[0].text === "Deploy 42 is green.", "speak/ROOM: it landed in the routine's own room, verbatim");

  ok(shouldBridgeAddressedProse(d.attrs[OE_ADDRESSING_ATTR] as string | undefined, false, undefined), "speak/BACKSTOP: the fire's delivery is still `direct-mention`, so terminal prose bridges to its origin");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-speak");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-silent", report: { kind: "silent" }, prompt: "Archive yesterday's rows." }));
  const { seen, to } = captureReceive();
  await tick(NOW, to);
  ok(seen.length === 1 && seen[0].unified, "silent: a silent routine still joins the window (it has work to do, it just says nothing)");
  ok(seen[0].attrs[ROUTINE_MARKER.silent] === "true", "silent: the host-set silent stamp rides the divert — the gate's unforgeable input");
  ok(!seen[0].message.includes("wake-id"), "silent/OPE-149 PRESERVED: a silent routine is NOT told a wake-id — the disclosure must not become the way a silent routine starts talking");
  ok(!seen[0].message.includes("<system-reminder>"), "silent: its message carries no reply mandate at all");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-silent");

  ok(fireWindow.renderFireWindowMessage("body", "w-1", { [ROUTINE_MARKER.silent]: "true" }) === "body", "silent/pure: renderFireWindowMessage returns the message UNTOUCHED for a silent fire");
  ok(fireWindow.renderFireWindowMessage("body", "w-1", {}).includes("w-1"), "silent/pure: and discloses the id for every other fire");
  ok(fireWindow.fireReplyMandate("w-1").includes(NO_REPLY_SENTINEL), "mandate: the silence exit is stated — a fire that judges silence warranted still has a cheap way to take it");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: false } });
  await routineStore.addRoutine({} as never, routine({ id: "r-native", prompt: "Post the deploy digest." }));
  const { seen, to } = captureReceive();
  await tick(NOW, to);
  ok(seen.length === 1 && !seen[0].unified, "native: flag-off still fires natively");
  ok(!seen[0].message.includes("wake-id"), "native: a non-diverted fire is told NO wake-id — there is no unified window to reply into, so the mandate would be a lie");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-native");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  const parentKey = unifiedDomainSessionKey(HEAL_DOMAIN);
  await store.rotateChannelSession(ORG, parentKey, "oe-dom:treasury:oe-sup:g1-old", "2026-07-01T00:00:00.000Z");
  const stale = await store.rotateChannelSession(ORG, parentKey, "oe-dom:treasury:oe-sup:g2-old", "2026-07-01T00:00:00.000Z");
  ok(stale.generation === 2, "heal/setup: the parent window sits at generation 2, minted under the old build");

  await routineStore.addRoutine(
    {} as never,
    routine({ id: "r-heal", sessionMode: "job", surfaceKey: HEAL_SURFACE, target: { channelId: HEAL_CHAN }, trigger: { kind: "interval", everyMinutes: 1 } }),
  );
  const a = captureReceive();
  await tick(NOW, a.to);
  ok(a.seen.length === 1 && a.seen[0].unified, "heal: the fire diverts into the window (this leg exercises the divert path)");
  const t1 = a.seen[0].target as unknown as UnifiedReceiveTarget;
  ok(
    parseWindowToken(t1.token)?.generation === 3,
    "🔴 heal: the fire's seat token carries a FRESH generation — without the heal it rides the stranded generation 2 and dies with no audit row",
  );

  const parentAfter = await store.getChannelSession(ORG, parentKey);
  ok(parentAfter?.generation === 3, "heal: the PARENT window's row rotated — a fire seat has no rotate verb, so healing the parent is the whole fix");
  ok(parentAfter?.token !== stale.token, "heal: the parent's token is a fresh mint, not the stranded one the next human wake would otherwise have resumed");
  ok(
    parentAfter?.token.startsWith("oe-dom:treasury:oe-sup:g3") === true,
    "heal: and it is the shape a human wake's own rotate leg mints (mintRotationToken over the grain), so that wake resumes a token it recognises",
  );

  const auditRows = await readAudit({ org: ORG, action: RUNTIME_ROTATION_AUDIT_ACTION });
  ok(
    auditRows.some((r) => (r.detail as { registryKey?: string } | undefined)?.registryKey === parentKey),
    "heal: the SHARED claim path did it — a `session.runtime_rotation` row names the parent window, the same row a human wake's heal writes",
  );

  const b = captureReceive();
  await tick(new Date(NOW.getTime() + 10 * 60_000), b.to);
  const t2 = b.seen[0].target as unknown as UnifiedReceiveTarget;
  ok(t2.token === t1.token, "heal/once: the NEXT fire RESUMES the healed seat — the claim is one-shot, so no generation is retired on every tick");
  ok((await store.getChannelSession(ORG, parentKey))?.generation === 3, "heal/once: and the parent window stays at the healed generation");

  ok(
    (await claimRuntimeRotation({ org: ORG, registryKey: parentKey, surfaceKey: HEAL_SURFACE, atIso: NOW.toISOString() })) === false,
    "🔴 heal/shared: a human wake arriving after the fire LOSES the claim — one rotation per window per eve bump, whoever reaches it first",
  );

  const jobKey = standingSeatRegistryKey(t1.token, HEAL_DOMAIN)!;
  ok((await store.getChannelSession(ORG, jobKey))?.token === t1.token, "heal: the job seat's registry row re-adopted onto the healed token");

  await routineStore.removeRoutine({ org: ORG, surfaceKey: HEAL_SURFACE } as never, "r-heal");
}

{
  const noRowCalls: string[] = [];
  const noRowStore = {
    async getChannelSession() {
      noRowCalls.push("read");
      return null;
    },
    async rotateChannelSession() {
      noRowCalls.push("rotate");
      throw new Error("a window with no row must never be minted one by a cron");
    },
  } as never;
  const unifiedGrain = { unified: true, registryKey: unifiedDomainSessionKey(HEAL_DOMAIN), domainName: HEAL_DOMAIN, singleWindow: true } as never;
  ok(
    (await fireWindow.healFireParentGeneration(ORG, unifiedGrain, NOW.toISOString(), noRowStore, false)) === undefined,
    "heal/no-row: a window that never opened a session has nothing eve could have stranded ⇒ no heal",
  );
  ok(!noRowCalls.includes("rotate"), "heal/no-row: and NO row is minted for it — a channel nobody has woken must not get a registry row from a cron tick");

  const nativeCalls: string[] = [];
  const nativeStore = {
    async getChannelSession() {
      nativeCalls.push("read");
      return null;
    },
    async rotateChannelSession() {
      nativeCalls.push("rotate");
      return null;
    },
  } as never;
  ok(
    (await fireWindow.healFireParentGeneration(ORG, { unified: false, registryKey: LONELY_SURFACE } as never, NOW.toISOString(), nativeStore, false)) === undefined,
    "heal/native: a NATIVE grain is REFUSED — this module cannot know a per-container token's shape, and a native fire joins no window",
  );
  ok(nativeCalls.length === 0, "heal/native: it refuses before it touches the store at all");

  let claims = 0;
  const diverted = await fireWindow.divertTriggeredFire((() => ({ send: async () => ({}) })) as never, {
    message: "digest",
    surfaceKey: HEAL_SURFACE,
    origin: { platform: "teams", serviceUrl: "https://smba.trafficmanager.net/", conversationId: "c1" } as never,
    seatKey: "job/r-nocodec",
    auth: {},
  }, {
    armed: true,
    org: ORG,
    claimRuntimeRotation: async () => {
      claims++;
      return true;
    },
  });
  ok(diverted === false, "heal/no-divert: a fire whose origin has no wake-origin codec still keeps the native path");
  ok(claims === 0, "🔴 heal/no-divert: and it never claims — a native fire that spent the window's one-shot claim would strand that window for the whole eve build");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  const rotaKey = unifiedDomainSessionKey(ROTA_DOMAIN);
  ok(
    (await claimRuntimeRotation({ org: ORG, registryKey: rotaKey, surfaceKey: ROTA_SURFACE, atIso: NOW.toISOString() })) === true,
    "chain/setup: burn ROTA_DOMAIN's runtime-change claim up front — every subtest below fires under runtimeChanged=false",
  );

  const realNow = Date.now();
  const minutesAgo = (n: number) => new Date(realNow - n * 60_000).toISOString();
  const hoursAgo = (n: number) => new Date(realNow - n * 3_600_000).toISOString();
  const daysAgo = (n: number) => new Date(realNow - n * 86_400_000).toISOString();

  {
    const seeded = await store.rotateChannelSession(ORG, rotaKey, "oe-dom:logistics:oe-sup:tokA1", minutesAgo(1));
    ok((await store.markChannelSessionRotation(ORG, rotaKey, minutesAgo(1))) === true, "chain/mark/setup: the mark lands on the seeded generation");
    const markedRow = await store.getChannelSession(ORG, rotaKey);
    ok(markedRow?.rotateMarkedAt != null, "chain/mark/setup: the row reads back marked before the fire");

    await routineStore.addRoutine(
      {} as never,
      routine({ id: "r-chain-a", sessionMode: "job", surfaceKey: ROTA_SURFACE, target: { channelId: ROTA_CHAN }, trigger: { kind: "interval", everyMinutes: 1 } }),
    );
    const a = captureReceive();
    await tick(NOW, a.to);
    ok(a.seen.length === 1 && a.seen[0].unified, "chain/mark: the fire diverts into the window");
    const t = a.seen[0].target as unknown as UnifiedReceiveTarget;
    ok(
      parseWindowToken(t.token)?.generation === seeded.generation + 1,
      "🔴 chain/mark: a routine fire ALONE rotates a marked parent — the fire seat's token carries the FRESH generation",
    );
    const parentAfter = await store.getChannelSession(ORG, rotaKey);
    ok(parentAfter?.generation === seeded.generation + 1, "chain/mark: the parent row rotated one generation");
    ok(parentAfter?.rotateMarkedAt === null, "chain/mark: and the mark is SPENT — any rotation clears it, whichever rung fired");
    await routineStore.removeRoutine({ org: ORG, surfaceKey: ROTA_SURFACE } as never, "r-chain-a");
  }

  {
    const seeded = await store.rotateChannelSession(ORG, rotaKey, "oe-dom:logistics:oe-sup:tokB1", daysAgo(8));
    await store.touchChannelSession(ORG, rotaKey, minutesAgo(5));
    const preFire = await store.getChannelSession(ORG, rotaKey);
    ok(preFire?.rotateMarkedAt == null, "chain/expiry/setup: unmarked — this subtest isolates expiry, not the mark");

    await routineStore.addRoutine(
      {} as never,
      routine({ id: "r-chain-b", sessionMode: "job", surfaceKey: ROTA_SURFACE, target: { channelId: ROTA_CHAN }, trigger: { kind: "interval", everyMinutes: 1 } }),
    );
    const b = captureReceive();
    await tick(NOW, b.to);
    ok(b.seen.length === 1 && b.seen[0].unified, "chain/expiry: the fire diverts into the window");
    const t = b.seen[0].target as unknown as UnifiedReceiveTarget;
    ok(
      parseWindowToken(t.token)?.generation === seeded.generation + 1,
      "🔴 chain/expiry: a routine fire rotates a parent whose generation aged past `rotation.expiryDays` — invisible to a fire before this fix",
    );
    ok((await store.getChannelSession(ORG, rotaKey))?.generation === seeded.generation + 1, "chain/expiry: the parent row rotated");
    await routineStore.removeRoutine({ org: ORG, surfaceKey: ROTA_SURFACE } as never, "r-chain-b");
  }

  {
    const seeded = await store.rotateChannelSession(ORG, rotaKey, "oe-dom:logistics:oe-sup:tokC1", hoursAgo(2));
    await routineStore.addRoutine(
      {} as never,
      routine({ id: "r-chain-c", sessionMode: "job", surfaceKey: ROTA_SURFACE, target: { channelId: ROTA_CHAN }, trigger: { kind: "interval", everyMinutes: 1 } }),
    );
    const c = captureReceive();
    await tick(NOW, c.to);
    ok(c.seen.length === 1 && c.seen[0].unified, "chain/quiet-gap: the fire diverts into the window");
    const t = c.seen[0].target as unknown as UnifiedReceiveTarget;
    ok(
      parseWindowToken(t.token)?.generation === seeded.generation + 1,
      "🔴 chain/quiet-gap: a routine fire rotates a parent idle past the quiet-gap threshold — invisible to a fire before this fix",
    );
    ok((await store.getChannelSession(ORG, rotaKey))?.generation === seeded.generation + 1, "chain/quiet-gap: the parent row rotated");
    await routineStore.removeRoutine({ org: ORG, surfaceKey: ROTA_SURFACE } as never, "r-chain-c");
  }

  {
    const seeded = await store.rotateChannelSession(ORG, rotaKey, "oe-dom:logistics:oe-sup:tokD1", minutesAgo(1));
    await routineStore.addRoutine(
      {} as never,
      routine({ id: "r-chain-d", sessionMode: "job", surfaceKey: ROTA_SURFACE, target: { channelId: ROTA_CHAN }, trigger: { kind: "interval", everyMinutes: 1 } }),
    );
    const d = captureReceive();
    await tick(NOW, d.to);
    ok(d.seen.length === 1 && d.seen[0].unified, "chain/healthy: the fire diverts into the window");
    const t = d.seen[0].target as unknown as UnifiedReceiveTarget;
    ok(parseWindowToken(t.token)?.generation === seeded.generation, "chain/healthy: a routine fire on a HEALTHY parent does NOT rotate it — the fire seat resumes the same generation");
    ok((await store.getChannelSession(ORG, rotaKey))?.generation === seeded.generation, "chain/healthy: the parent row is unchanged");
    await routineStore.removeRoutine({ org: ORG, surfaceKey: ROTA_SURFACE } as never, "r-chain-d");
  }
}

{
  const rotaKey2 = unifiedDomainSessionKey(ROTA_DOMAIN);
  const rotaGrain = { unified: true, registryKey: rotaKey2, domainName: ROTA_DOMAIN, singleWindow: true } as never;
  const rowAt = (over: Record<string, unknown>) => ({
    token: "t1",
    generation: 5,
    createdAt: NOW.toISOString(),
    lastWakeAt: NOW.toISOString(),
    turnCount: 0,
    inputTokensTotal: 0,
    firstWakeAt: null,
    lastInputTokens: null,
    rotateMarkedAt: null,
    ...over,
  });

  {
    const angryStore = { async getChannelSession() { return rowAt({}); }, async rotateChannelSession() { throw new Error("store down"); } } as never;
    let threw = false;
    try {
      await fireWindow.healFireParentGeneration(ORG, rotaGrain, NOW.toISOString(), angryStore, true);
    } catch {
      threw = true;
    }
    ok(threw, "chain/throw: the runtime-changed rung throws on a store failure — it is a one-shot claim, not a re-derivable rung");
  }

  {
    const angryStore = {
      async getChannelSession() {
        return rowAt({ rotateMarkedAt: NOW.toISOString() });
      },
      async rotateChannelSession() {
        throw new Error("store down");
      },
    } as never;
    const result = await fireWindow.healFireParentGeneration(ORG, rotaGrain, NOW.toISOString(), angryStore, false);
    ok(result === undefined, "chain/fail-soft: the operator-marked rung fails SOFT on a store error — the fire is never lost over registry bookkeeping");
  }

  {
    let rotateCalls = 0;
    const quietStore = {
      async getChannelSession() {
        return rowAt({});
      },
      async rotateChannelSession() {
        rotateCalls++;
        throw new Error("must not be called — no rung fired");
      },
    } as never;
    ok(
      (await fireWindow.healFireParentGeneration(ORG, rotaGrain, NOW.toISOString(), quietStore, false)) === undefined,
      "chain/no-trigger: a healthy row with runtimeChanged=false triggers no rung",
    );
    ok(rotateCalls === 0, "chain/no-trigger: and rotateChannelSession is never called — no over-rotation on a fire that has nothing to heal");
  }
}

overrideSettingsForTest({ delegation: { oneshotAgent: false } });
rmSync(dir, { recursive: true, force: true });
console.log(`✓ triggered-fire-window: ${passed} assertions passed`);
