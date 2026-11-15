// proves: ROUT-56

import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-triggered-fire-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
overrideSettingsForTest({ delegation: { oneshotAgent: false } });
overrideSettingsForTest({ window: { topology: true } });

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { liveFireWorkDeps } = await import("../agent/routines/fire-work.js");
const { classifySessionId, isThreadSeatWindowToken } = await import("../agent/channels/window-key.js");
const { OE_GRAIN_ATTR } = await import("../agent/channels/unified-window.js");
const { OE_REQUESTER_ATTR, OE_REQUESTER_CANDIDATES_ATTR, REQUESTER_UNVERIFIED } = await import("../agent/access/requester-identity.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { ROUTINE_MARKER, routineMarker } = await import("../agent/routines/routine.js");
const { WEBHOOK_MARKER_ATTR, webhookFireAttributes } = await import("../agent/routines/fire-auth.js");
const unifiedMod = await import("../agent/channels/unified.js");
const unifiedChannel = unifiedMod.default;

type Routine = import("../agent/routines/routine.js").Routine;
type UnifiedReceiveTarget = import("../agent/channels/unified.js").UnifiedReceiveTarget;
type FireWindowDeps = import("../agent/routines/fire-window.js").FireWindowDeps;

const ORG = "default";
const DOMAIN = "payments";
const TEAM = "T_FIRE";
const CHAN = "C_FIRE";
const SURFACE = `slack/${TEAM}/${CHAN}`;
const LONELY_SURFACE = "slack/T_FIRE/C_LONELY";

const SLACK_CHANNEL = { __fixture: "slack" } as never;
registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => true });
registerSlackFixtureCodec();
registerSlackFixtureMapper();

const winDomain = defineDomain({ name: DOMAIN, reach: [SURFACE], ambientSupervisor: true, mode: "unified" });
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [winDomain],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === CHAN ? [DOMAIN] : []),
});

const store = getOperationalStore();

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

const NO_SURFACE: FireWindowDeps = { work: { ...liveFireWorkDeps(ORG), binding: () => undefined } };

async function tick(now: Date, to: unknown, appAttrs: Record<string, unknown> = {}, fireWindowDeps: FireWindowDeps = {}): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({
    now,
    to,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    appAuth: { attributes: appAttrs },
    postJobKickoff: async () => "1700000000.0001",
    fireWindow: fireWindowDeps,
  } as never);
  await Promise.all(pending);
}

const NOW = new Date("2026-07-02T12:00:00.000Z");

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-clock-w" }));
  const { seen, to } = captureReceive();
  await tick(NOW, to);
  ok(seen.length === 1, "clock/W: exactly one delivery");
  const target = seen[0].target as unknown as UnifiedReceiveTarget;
  ok(classifySessionId(target.token).kind === "work", "🔴 clock/W: the live fire goes to the domain's WORK SESSION token — no per-domain switch leaves it on a thread seat");
  ok(!isThreadSeatWindowToken(target.token), "clock/W: and mints no thread seat");
  ok(seen[0].attrs[OE_GRAIN_ATTR] === "standing", "clock/W: the forward is stamped standing grain, never the fire seat's thread grain");
  ok(seen[0].attrs[OE_REQUESTER_ATTR] === REQUESTER_UNVERIFIED, "clock/W: the forward names nobody");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-clock-w");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-no-surface" }));
  const { seen, to } = captureReceive();
  await tick(NOW, to, {}, NO_SURFACE);
  ok(seen.length === 1, "no-surface: exactly one delivery");
  ok(!seen[0].unified, "🔴 no-surface: the fire keeps the NATIVE send — the thread-seat fire is retired, so no unified delivery is made");
  ok(seen[0].attrs[OE_GRAIN_ATTR] === undefined, "no-surface: no window stamp rides the native fire");
  ok(seen[0].target["channelId"] === CHAN, "no-surface: the native target is the routine's own channel");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-no-surface");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  await routineStore.addRoutine({} as never, routine({ id: "r-stale-candidates" }));
  const { seen, to } = captureReceive();
  await tick(NOW, to, { [OE_REQUESTER_CANDIDATES_ATTR]: JSON.stringify(["U_ORG_A", "U_ORG_B"]), oe_unrelated_probe: "kept" });
  ok(seen.length === 1 && seen[0].unified, "stale-candidates: the fire is still forwarded into the work session (the leg is exercising the forward)");
  ok(classifySessionId((seen[0].target as unknown as UnifiedReceiveTarget).token).kind === "work", "stale-candidates: …to W's token");
  ok(
    seen[0].attrs[OE_REQUESTER_CANDIDATES_ATTR] === undefined,
    "🔴 stale-candidates: a candidate list already in the forwarded app bag is DELETED — a fire may never be served on another turn's askers",
  );
  ok(seen[0].attrs[OE_REQUESTER_ATTR] === REQUESTER_UNVERIFIED, "…while the who-asked stamp beside it is still written, so the refusal stays honest rather than silent");
  ok(seen[0].attrs["oe_unrelated_probe"] === "kept", "negative control: an unrelated forwarded attribute DOES survive the fire, so the delete above is targeted");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-stale-candidates");
}

{
  overrideSettingsForTest({ delegation: { oneshotAgent: false } });
  await routineStore.addRoutine({} as never, routine({ id: "r-off" }));
  const { seen, to } = captureReceive();
  await tick(NOW, to);
  ok(seen.length === 1 && !seen[0].unified, "flag-off: the fire lands NATIVE — delegation disarmed means no work session runs the fire, so the forward must not apply");
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
  ok(lost.length === 1, "forensics: a failed DIVERT lands the SAME `routine.fire_lost` row a failed native receive does — the trail does not move when the road does");
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
  ok(classifySessionId((seen[0].target as unknown as UnifiedReceiveTarget).token).kind === "work", "event: it is forwarded to the domain's WORK SESSION");
  ok(seen[0].attrs[OE_GRAIN_ATTR] === "standing", "event: standing grain, never the retired fire seat's thread grain");
  ok(routineMarker(seen[0].attrs as never)?.id === "r-event", "event: the routine marker still rides");
  const et = seen[0].target as unknown as UnifiedReceiveTarget;
  ok((await store.getUnifiedWakeTarget(ORG, et.wakeId)) !== null, "event: W's `wakeId → origin` row is registered");

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
  ok(seen.length === 1 && seen[0].unified, "webhook: an unattended, PUBLICLY-triggered fire joins the window — not the `native` posture a live human channel turn carries");
  const wt = seen[0].target as unknown as UnifiedReceiveTarget;
  ok(classifySessionId(wt.token).kind === "work" && !isThreadSeatWindowToken(wt.token), "webhook: it is forwarded to the domain's WORK SESSION, and mints no thread seat");
  ok(seen[0].attrs[OE_GRAIN_ATTR] === "standing", "webhook: standing grain on the forward");
  ok(seen[0].attrs[WEBHOOK_MARKER_ATTR] === "deploy-status", "webhook: the hook marker rides through the forward");
  ok(seen[0].attrs[ROUTINE_MARKER.id] === undefined, "webhook: a hook fire carries no routine marker (it is not a routine — the outcome hook stays a no-op)");
  ok((await store.getUnifiedWakeTarget(ORG, wt.wakeId)) !== null, "webhook: W's `wakeId → origin` row is registered");
  ok(typeof res.wakeId === "string" && res.wakeId.length > 0, "webhook/JOIN: the fire returns its own wake id — the handle the audit row and the result wake's reply carry");

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

overrideSettingsForTest({ delegation: { oneshotAgent: false } });
await removeTempDir(dir);
console.log(`✓ triggered-fire-window: ${passed} assertions passed`);
