import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-event-fanout-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
delete process.env.OE_EVENT_MAX_FANOUT;

const { registerSlackTestBridge } = await import("./_slack-test-stubs.js");
const { registerRoutineDispatch, resolveRoutineTarget } = await import("../agent/schedules/routine-dispatch.js");
const { fanOutDelivery, deliveryDedupeKey } = await import("../agent/routines/github-fanout.js");
const { routineFireAttributes } = await import("../agent/routines/fire-auth.js");
const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
type Routine = import("../agent/routines/routine.js").Routine;
type AuditInput = import("../agent/operational/store.js").AuditInput;
type DispatchTarget = import("../agent/schedules/routine-dispatch.js").DispatchTarget;

const SLACK_CHANNEL = { __fixture: "slack" } as never;
const DISCORD_CHANNEL = { __fixture: "discord" } as never;

registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => true });

registerRoutineDispatch("discord", {
  resolveTarget: (r: Routine): DispatchTarget | null => {
    const channelId = typeof r.target?.["channelId"] === "string" ? (r.target["channelId"] as string) : undefined;
    if (!channelId) return null;
    return {
      channel: DISCORD_CHANNEL,
      target: { channelId },
      mode: "channel",
      attributes: { guild_id: r.surfaceKey.split("/")[1] ?? "", channel_id: channelId, channel_type: "0" },
    };
  },
});

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: "acme",
    surfaceKey: "slack/T1/C1",
    target: { channelId: "C1" },
    trigger: { kind: "event", source: "github" },
    prompt: "Summarise the PR.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}

const PR_BODY = JSON.stringify({
  action: "opened",
  pull_request: { number: 42, title: "Add caching", html_url: "https://github.com/me/proj/pull/42" },
  repository: { full_name: "me/proj" },
  sender: { login: "alice" },
});

interface Fired {
  channel: unknown;
  message: string;
  target: Record<string, unknown>;
  auth: { authenticator?: string; principalType?: string; principalId?: string; attributes: Record<string, string> };
}
function harness(routines: Routine[]) {
  const fired: Fired[] = [];
  const audited: AuditInput[] = [];
  return {
    fired,
    audited,
    deps: {
      receive: ((channel: unknown, opts: unknown) => {
        fired.push({ channel, ...(opts as Omit<Fired, "channel">) });
        return Promise.resolve();
      }) as never,
      listRoutines: async () => routines,
      audit: async (e: AuditInput) => {
        audited.push(e);
      },
    },
  };
}

{
  const mine = routine({ id: "r-mine" });
  const theirs = routine({ id: "r-theirs", org: "globex", surfaceKey: "slack/T9/C9", target: { channelId: "C9" } });
  const h = harness([mine, theirs]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 1, "org filter: exactly one routine fires for an acme delivery");
  ok(h.fired[0]!.auth.attributes[ROUTINE_MARKER.id] === "r-mine", "org filter: an org-B routine NEVER matches an org-A delivery");
}

{
  const h = harness([routine({ id: "r-off", status: "disabled" })]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 0, "org filter: a disabled routine is still excluded");
}

{
  const h = harness([routine({ id: "r-attrs" })]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 1, "fire auth: the slack-targeted routine fires");
  const a = h.fired[0]!.auth;
  ok(a.attributes["team_id"] === "T1", "OPE-143: team_id is stamped (the fire binds to the routine's real workspace)");
  ok(a.attributes["channel_id"] === "C1", "OPE-143: channel_id is stamped (memory silo / skills / spend land on the right surface)");
  ok(a.attributes["channel_type"] === "channel", "OPE-143: channel_type is stamped");
  ok(a.attributes[ROUTINE_MARKER.id] === "r-attrs", "the routine marker id still rides (outcome attribution)");
  ok(a.attributes[ROUTINE_MARKER.surface] === "slack/T1/C1", "the routine marker surface still rides");
  ok(a.attributes[ROUTINE_MARKER.org] === "acme", "the routine marker org still rides");
  ok(a.authenticator === "github" && a.principalType === "service" && a.principalId === "github:webhook", "the fire is still a SERVICE principal — no fake human is invented");
  ok(
    a.attributes["is_ext_shared"] === "false" && a.attributes["trust_checked"] === "true",
    "a CONFIRMED-internal slack channel stamps the LIVE trust verdict (arms shared memory / domain skills), same as a clock fire",
  );
  ok(h.fired[0]!.target["channelId"] === "C1", "the fire targets the routine's resolved adapter target");
  ok(h.fired[0]!.channel === SLACK_CHANNEL, "the fire goes to the resolved channel object, not a hardcoded one");
}

{
  const r = routine({ id: "r-shape" });
  const dest = resolveRoutineTarget(r)!;
  const h = harness([r]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  const expected = routineFireAttributes(r, dest.attributes, dest.mode, true);
  ok(
    JSON.stringify(h.fired[0]!.auth.attributes) === JSON.stringify(expected),
    "OPE-143: the fan-out's attribute bag is EXACTLY routineFireAttributes — not a parallel shape that can drift",
  );
}

{
  registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => false });
  const h = harness([routine({ id: "r-untrusted" })]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 1 && h.fired[0]!.auth.attributes["is_ext_shared"] === undefined, "an UNCONFIRMED channel stamps no trust (fail-closed) but still fires");
  registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => true });
}

{
  const d = routine({ id: "r-discord", surfaceKey: "discord/G1/D9", target: { channelId: "D9" } });
  const dest = resolveRoutineTarget(d);
  ok(dest !== null && dest.channel === DISCORD_CHANNEL, "a non-slack event routine RESOLVES a dispatch target through the registered seam");
  const h = harness([d]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 1, "OPE-139: a Discord-targeted event routine FIRES (it used to be silently skipped as 'no wired channel')");
  ok(h.fired[0]!.channel === DISCORD_CHANNEL, "the discord fire goes to the bundle's channel");
  ok(h.fired[0]!.auth.attributes["guild_id"] === "G1" && h.fired[0]!.auth.attributes["channel_id"] === "D9", "the discord fire carries the bundle resolver's platform attributes");
  ok(h.fired[0]!.auth.attributes["is_ext_shared"] === undefined, "a non-slack fire stamps no trust — there is no membership gate to confirm it (fail-closed)");
}

{
  const h = harness([routine({ id: "r-nowhere", surfaceKey: "linear/W1/S1", target: { channelId: "S1" } })]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 0, "an unresolvable surface is skipped without firing");
  ok(h.audited.length === 1, "OPE-145: the unwired skip is AUDITED (it used to be console-log only)");
  ok(
    h.audited[0]!.action === "routine.skip" && h.audited[0]!.detail?.["reason"] === "unresolved_target",
    "OPE-145: an unwired skip is the SAME action as a cap skip, distinguished by `reason` — not a second vocabulary",
  );
  ok(h.audited[0]!.platform === "linear" && h.audited[0]!.workspace === "W1" && h.audited[0]!.surface === "S1", "the unwired skip row is attributed to the routine's own partition");
}

{
  process.env.OE_EVENT_MAX_FANOUT = "2";
  const rs = [routine({ id: "r-1" }), routine({ id: "r-2" }), routine({ id: "r-3" })];
  const h = harness(rs);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 2, "cap: N+1 matches with a cap of N ⇒ exactly N fire");
  ok(h.audited.length === 1, "cap: the over-cap match writes exactly one audit row");
  const row = h.audited[0]!;
  ok(row.action === "routine.skip", "cap: the skip is audited under the shared routine.skip action (not indistinguishable from silence)");
  ok(row.org === "acme" && row.platform === "slack" && row.workspace === "T1" && row.surface === "C1", "cap: the skip row is attributed to the SKIPPED routine's own partition");
  ok(row.detail?.["routineId"] === "r-3" && row.detail?.["reason"] === "fanout_cap", "cap: the skip row names the routine and the reason");
  ok(row.detail?.["cap"] === 2 && row.detail?.["matched"] === 3, "cap: the skip row records the cap and the match count");
  delete process.env.OE_EVENT_MAX_FANOUT;
}

{
  const rs = [1, 2, 3, 4, 5].map((n) => routine({ id: `r-d${n}` }));
  const h = harness(rs);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 3, "cap: the default fan-out cap is 3 (mirrors the clock dispatcher's DEFAULT_MAX_CONCURRENCY)");
  ok(h.audited.length === 2, "cap: every over-cap match is audited, not just the first");

  process.env.OE_EVENT_MAX_FANOUT = "not-a-number";
  const h2 = harness(rs);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h2.deps);
  ok(h2.fired.length === 3, "cap: a non-numeric OE_EVENT_MAX_FANOUT falls back to the default");
  process.env.OE_EVENT_MAX_FANOUT = "0";
  const h3 = harness(rs);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h3.deps);
  ok(h3.fired.length === 3, "cap: a zero/negative OE_EVENT_MAX_FANOUT falls back to the default (never a silent total mute)");
  delete process.env.OE_EVENT_MAX_FANOUT;
}

{
  const h = harness([routine({ id: "r-dedupe" })]);
  await fanOutDelivery(PR_BODY, "pull_request", "delivery-aaa", h.deps);
  ok(h.fired.length === 1, "dedupe: the first sighting of a delivery id fires");
  await fanOutDelivery(PR_BODY, "pull_request", "delivery-aaa", h.deps);
  ok(h.fired.length === 1, "dedupe: the SAME delivery id a second time fires nothing (GitHub redelivers on any non-2xx)");
  await fanOutDelivery(PR_BODY, "pull_request", "delivery-bbb", h.deps);
  ok(h.fired.length === 2, "dedupe: a DIFFERENT delivery id still fires");
}

{
  const store = getOperationalStore();
  ok(
    (await store.markEventSeen("acme", deliveryDedupeKey("delivery-aaa"), new Date().toISOString(), 600_000)) === false,
    "dedupe: the durable mark is written under a gh-fanout-namespaced key (no collision with inbound slack event ids)",
  );
  const h = harness([routine({ id: "r-ping" })]);
  await fanOutDelivery(JSON.stringify({}), "ping", "delivery-ping", h.deps);
  ok(
    (await store.markEventSeen("acme", deliveryDedupeKey("delivery-ping"), new Date().toISOString(), 600_000)) === true,
    "dedupe: an unmodelled event (ping) never burns a dedupe slot",
  );
}

{
  const h = harness([routine({ id: "r-nodelivery" })]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 2, "dedupe: a delivery with no id is not deduped (never silently dropped for lack of a key)");
}

{
  const store = getOperationalStore();
  const t0 = Date.parse("2026-02-24T06:00:00.000Z");
  const iso = (ms: number): string => new Date(t0 + ms).toISOString();
  ok(await store.markEventSeen("acme", "prune-long", iso(0), 600_000), "prune: a 10-minute key is first-seen");
  ok(await store.markEventSeen("acme", "prune-short", iso(70_000), 60_000), "prune: an unrelated 60-second key is first-seen");
  ok(
    (await store.markEventSeen("acme", "prune-long", iso(80_000), 600_000)) === false,
    "prune: the 60-second caller did NOT evict the 10-minute key — per-key TTL, not a table-wide sweep",
  );
  ok(
    await store.markEventSeen("acme", "prune-long", iso(700_000), 600_000),
    "prune: past its OWN ttl the 10-minute key is expired and fresh again",
  );
  ok(await store.markEventSeen("globex", "prune-long", iso(0), 600_000), "prune: another org's identical key is untouched (org-scoped)");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ event-fanout: ${passed} assertions passed`);
