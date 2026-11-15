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

const dir = join(tmpdir(), `open-everywhere-event-fanout-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });
overrideSettingsForTest({ routines: { eventMaxFanout: 3 } });

const { registerSlackTestBridge } = await import("./_slack-test-stubs.js");
const { registerRoutineDispatch, resolveRoutineTarget } = await import("../agent/schedules/routine-dispatch.js");
const { fanOutDelivery, deliveryDedupeKey } = await import("../agent/routines/github-fanout.js");
const { routineFireAttributes } = await import("../agent/routines/fire-auth.js");
const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
const { OE_TAINTED_FIRE_ATTR } = await import("../agent/access/taint-signal.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { registerEntityRead } = await import("../agent/routines/entity-read.js");
type Routine = import("../agent/routines/routine.js").Routine;
type AuditInput = import("../agent/operational/store.js").AuditInput;
type DispatchTarget = import("../agent/schedules/routine-dispatch.js").DispatchTarget;

const SLACK_CHANNEL = { __fixture: "slack" } as never;
const DISCORD_CHANNEL = { __fixture: "discord" } as never;

registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => true });

registerEntityRead({ platform: "github", read: async () => ({ status: "gone" }) });

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
function harness(routines: Routine[], repos: readonly string[] = ["me/proj"]) {
  const fired: Fired[] = [];
  const audited: AuditInput[] = [];
  return {
    fired,
    audited,
    deps: {
      to: ((channel: unknown, target: unknown) => ({
        send: (message: unknown, opts: unknown) => {
          fired.push({ channel, target, message, ...(opts as { auth: Fired["auth"] }) } as Fired);
          return Promise.resolve();
        },
      })) as never,
      listRoutines: async () => routines,
      audit: async (e: AuditInput) => {
        audited.push(e);
      },
      grant: { resolve: () => ({ repos }) as never },
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
  const actual = h.fired[0]!.auth.attributes as Record<string, string>;
  const { [OE_TAINTED_FIRE_ATTR]: taint, ...rest } = actual;
  const fireId = actual[ROUTINE_MARKER.fire];
  ok(
    typeof fireId === "string" && fireId.length > 0,
    "OPE-626: an event fire stamps a per-fire id, so the outcome fold has a latch key on the native path as well as the windowed one",
  );
  const shared = routineFireAttributes(r, dest.attributes, dest.mode, true, undefined, fireId);
  ok(
    JSON.stringify(rest) === JSON.stringify(shared),
    "OPE-143: the fan-out's attribute bag is EXACTLY routineFireAttributes — not a parallel shape that can drift",
  );
  ok(
    taint === undefined,
    "🔴 OPE-2720: a content-bearing event fire carries NO taint stamp — the prompt's outside bytes ride inside the untrusted fence, and no producer stamps a fire",
  );
  ok(Object.keys(actual).length === Object.keys(shared).length, "…so the bag is EXACTLY the shared bag, with nothing added");
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
  overrideSettingsForTest({ routines: { eventMaxFanout: 2 } });
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
  overrideSettingsForTest({ routines: { eventMaxFanout: 3 } });
}

{
  const rs = [1, 2, 3, 4, 5].map((n) => routine({ id: `r-d${n}` }));
  const h = harness(rs);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 3, "cap: the default fan-out cap is 3 (mirrors the clock dispatcher's DEFAULT_MAX_CONCURRENCY)");
  ok(h.audited.length === 2, "cap: every over-cap match is audited, not just the first");

  process.env.OE_EVENT_MAX_FANOUT = "1";
  const h2 = harness(rs);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h2.deps);
  ok(h2.fired.length === 3, "cap: a stray OE_EVENT_MAX_FANOUT=1 does NOT narrow the fan-out — the mirror is deleted (OPE-411)");
  delete process.env.OE_EVENT_MAX_FANOUT;
  overrideSettingsForTest({ routines: { eventMaxFanout: 3 } });
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
    (await store.markEventSeen("acme", deliveryDedupeKey("github", "delivery-aaa"), new Date().toISOString(), 600_000)) === false,
    "dedupe: the durable mark is written under a SOURCE-namespaced key (no collision with inbound slack event ids, and no collision between two trigger sources whose id spaces overlap)",
  );
  const h = harness([routine({ id: "r-ping" })]);
  await fanOutDelivery(JSON.stringify({}), "ping", "delivery-ping", h.deps);
  ok(
    (await store.markEventSeen("acme", deliveryDedupeKey("github", "delivery-ping"), new Date().toISOString(), 600_000)) === true,
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

{
  const under = routine({ id: "r-under", trigger: { kind: "event", source: "github", jq: '.scope.container == "me/proj"' } });
  const h = harness([under]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 1, "match: a scope equality on the delivery's container FIRES");

  const elsewhere = routine({ id: "r-elsewhere", trigger: { kind: "event", source: "github", jq: '.scope.container == "other/repo"' } });
  const h2 = harness([elsewhere]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h2.deps);
  ok(h2.fired.length === 0, "match: a scope equality naming a DIFFERENT container never fires");

  const set = routine({
    id: "r-in",
    trigger: { kind: "event", source: "github", jq: '(.fields["action"] | IN("opened", "reopened", "synchronize"))' },
  });
  const h3 = harness([set]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h3.deps);
  ok(h3.fired.length === 1, "match: an `IN` clause matches any value in the set");

  const notMe = routine({ id: "r-notin", trigger: { kind: "event", source: "github", jq: '(.fields["sender"] | IN("alice") | not)' } });
  const h4 = harness([notMe]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h4.deps);
  ok(h4.fired.length === 0, "match: an `IN(…) | not` clause SUPPRESSES the actor it names (the generic self-trigger guard)");
}

{
  const broken = routine({ id: "r-broken", trigger: { kind: "event", source: "github", jq: '.scope.container == "me/proj" and' } });
  const h = harness([broken]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 0, "filter error: a filter that will not parse does NOT fire — fail-closed, never fail-open");
  ok(h.audited.length === 1 && h.audited[0]!.action === "routine.skip", "filter error: the skip is audited, not silent");
  ok(h.audited[0]!.detail?.["reason"] === "filter_invalid", "filter error: the reason distinguishes a broken filter from a genuine non-match");
  ok(String(h.audited[0]!.detail?.["why"] ?? "").length > 0, "filter error: the row carries jq's own message");
  ok(
    String(h.audited[0]!.detail?.["filter"] ?? "").includes(".scope.container"),
    "filter error: …AND the expression that produced it — without it the reader has a message with nothing to attach it to",
  );
}

{
  const nonBool = routine({ id: "r-nonbool", trigger: { kind: "event", source: "github", jq: ".fields.action" } });
  const h = harness([nonBool]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 0, "filter error: a non-boolean result is NOT coerced to truthy — it does not fire");
  ok(h.audited[0]?.detail?.["reason"] === "filter_invalid", "filter error: …and it is audited the same way");
}

{
  const undeclared = routine({ id: "r-undeclared", trigger: { kind: "event", source: "github", jq: '(.fields["branch"] | IN("main"))' } });
  const h = harness([undeclared]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 0, "undeclared field: a filter on a field the source does not emit does NOT fire");
  ok(h.audited.length === 0, "undeclared field: …and it is a CLEAN non-match, not an audited error — there is no key vocabulary left to drift against");
}

{
  const r = routine({ id: "r-ungranted" });
  const h = harness([r], []);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
  ok(h.fired.length === 0, "grant: a perfect filter with NO read grant on the event's scope never fires");
  ok(h.audited.length === 1 && h.audited[0]!.action === "routine.skip", "grant: the refusal is audited — 'matches but never fires' must not look like 'never matches'");
  ok(h.audited[0]!.detail?.["reason"] === "grant_refused", "grant: the audited reason is grant_refused");
  ok(h.audited[0]!.detail?.["grant"] === "refused", "grant: the sub-reason rides its OWN key — it must never overwrite the skip reason readers switch on");
  ok(h.audited[0]!.detail?.["partition"] === "slack/T1/C1", "grant: the row names WHICH partition refused");
}

{
  const r = routine({ id: "r-revoked" });
  const before = harness([r], ["me/proj"]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, before.deps);
  ok(before.fired.length === 1, "grant: a granted routine fires");
  const after = harness([r], ["me/other"]);
  await fanOutDelivery(PR_BODY, "pull_request", undefined, after.deps);
  ok(after.fired.length === 0, "grant: revoking the grant AFTER arming stops the fire (checked at fire time, not only at create)");
}

{
  const h = harness([routine({ id: "r-unresolvable" })]);
  const deps = {
    ...h.deps,
    grant: {
      resolve: () => {
        throw new Error("config unloadable");
      },
    },
  };
  await fanOutDelivery(PR_BODY, "pull_request", undefined, deps);
  ok(h.fired.length === 0, "grant: an unresolvable config fails CLOSED (no fire)");
  ok(
    h.audited[0]?.detail?.["reason"] === "grant_refused" && h.audited[0]?.detail?.["grant"] === "unresolvable",
    "grant: an unresolvable config is audited under the same skip reason, with its own sub-reason",
  );
}

{
  overrideSettingsForTest({ routines: { eventMaxFanout: 1 } });
  const rs = [routine({ id: "r-cap-ungranted", surfaceKey: "slack/T1/C2", target: { channelId: "C2" } }), routine({ id: "r-cap-granted" })];
  const h = {
    fired: [] as Fired[],
    audited: [] as AuditInput[],
  };
  const deps = {
    to: ((channel: unknown, target: unknown) => ({
      send: (message: unknown, opts: unknown) => {
        h.fired.push({ channel, target, message, ...(opts as { auth: Fired["auth"] }) } as Fired);
        return Promise.resolve();
      },
    })) as never,
    listRoutines: async () => rs,
    audit: async (e: AuditInput) => {
      h.audited.push(e);
    },
    grant: { resolve: (p: { surfaceKey: string }) => ({ repos: p.surfaceKey === "slack/T1/C1" ? ["me/proj"] : [] }) as never },
  };
  await fanOutDelivery(PR_BODY, "pull_request", undefined, deps);
  ok(h.fired.length === 1, "grant: the granted routine still fires with a cap of 1");
  ok(h.fired[0]!.auth.attributes[ROUTINE_MARKER.id] === "r-cap-granted", "grant: an UNGRANTED routine never consumes fan-out cap");
  overrideSettingsForTest({ routines: { eventMaxFanout: 3 } });
}

{
  interface Patch {
    id: string;
    org: string;
    surfaceKey: string;
    patch: Record<string, unknown>;
  }
  function stampHarness(routines: Routine[], repos: readonly string[] = ["me/proj"], t0 = Date.parse("2026-07-28T09:00:00.000Z")) {
    const writes: Patch[] = [];
    const kept: Patch[] = [];
    const clock = { ms: t0 };
    const base = harness(routines, repos);
    return {
      ...base,
      writes,
      kept,
      clock,
      deps: {
        ...base.deps,
        matchStamp: {
          now: () => new Date(clock.ms),
          update: async (org: string, surfaceKey: string, id: string, patch: Record<string, unknown>) => {
            ("lastEvent" in patch ? kept : writes).push({ id, org, surfaceKey, patch });
            const row = routines.find((r) => r.id === id);
            if (row) Object.assign(row, patch);
            return row ?? null;
          },
        },
      },
    };
  }

  {
    const r = routine({ id: "r-stamp" });
    const h = stampHarness([r]);
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.fired.length === 1 && h.writes.length === 1, "match stamp: a matching subscription writes exactly one stamp");
    ok(h.kept.length === 1 && h.kept[0]!.id === "r-stamp", "match stamp: …and keeps the event once, for a test replay (OPE-2540)");
    const w = h.writes[0]!;
    ok(w.id === "r-stamp" && w.org === "acme" && w.surfaceKey === "slack/T1/C1", "match stamp: the stamp is written against the matching routine's own (org, surfaceKey, id)");
    ok(w.patch["firstMatchAt"] === "2026-07-28T09:00:00.000Z", "match stamp: the FIRST match sets firstMatchAt");
    ok(w.patch["lastMatchAt"] === "2026-07-28T09:00:00.000Z", "match stamp: …and lastMatchAt");
  }

  {
    const r = routine({ id: "r-stamp-nomatch", trigger: { kind: "event", source: "github", jq: '.scope.container == "other/repo"' } });
    const h = stampHarness([r]);
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.fired.length === 0 && h.writes.length === 0 && h.kept.length === 0, "match stamp: a filter that does not match writes NO stamp and keeps no event");
  }

  {
    const r = routine({ id: "r-stamp-broken", trigger: { kind: "event", source: "github", jq: '.scope.container == "me/proj" and' } });
    const h = stampHarness([r]);
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.writes.length === 0 && h.kept.length === 0, "match stamp: a filter that will NOT EVALUATE never stamps and keeps no event — a broken filter must not look like a working one");
    ok(
      h.audited.length === 1 && h.audited[0]!.detail?.["reason"] === "filter_invalid",
      "match stamp: …and it still reports itself through the existing filter_invalid skip row, so the failure is not silent either",
    );
  }
  {
    const r = routine({ id: "r-stamp-nonbool", trigger: { kind: "event", source: "github", jq: ".fields.action" } });
    const h = stampHarness([r]);
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.writes.length === 0 && h.kept.length === 0, "match stamp: a non-boolean filter result never stamps, and keeps no event, either");
  }

  {
    const r = routine({ id: "r-stamp-ungranted" });
    const h = stampHarness([r], []);
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.fired.length === 0, "match stamp: the ungranted routine does not fire");
    ok(h.writes.length === 1 && h.writes[0]!.patch["lastMatchAt"] !== undefined, "OPE-184: a GRANT-REFUSED match still stamps — the stamp is strictly BEFORE the read-grant check");
    ok(h.kept.length === 0, "🔴 OPE-2540: a GRANT-REFUSED match keeps NO event for a test replay — an event the domain may not read is never kept");
    ok(h.audited.some((e) => e.detail?.["reason"] === "grant_refused"), "match stamp: …and the downstream reason keeps its own separate vocabulary (routine.skip/grant_refused)");
  }

  {
    const r = routine({ id: "r-stamp-unwired", surfaceKey: "linear/W1/S1", target: { channelId: "S1" } });
    const h = stampHarness([r]);
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.fired.length === 0, "match stamp: the unwired routine does not fire");
    ok(h.writes.length === 1 && h.writes[0]!.id === "r-stamp-unwired", "OPE-184: an UNRESOLVED-TARGET match still stamps — the stamp is strictly BEFORE target resolution");
  }

  {
    overrideSettingsForTest({ routines: { eventMaxFanout: 1 } });
    const rs = [routine({ id: "r-stamp-cap1" }), routine({ id: "r-stamp-cap2" })];
    const h = stampHarness(rs);
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.fired.length === 1, "match stamp: with a cap of 1 exactly one of the two fires");
    ok(h.writes.length === 2, "OPE-184: BOTH matches stamp — the stamp is strictly BEFORE the fan-out cap");
    ok(h.writes.map((w) => w.id).join(",") === "r-stamp-cap1,r-stamp-cap2", "match stamp: …including the routine that was skipped as over-cap");
    overrideSettingsForTest({ routines: { eventMaxFanout: 3 } });
  }

  {
    const r = routine({ id: "r-stamp-coalesce" });
    const h = stampHarness([r]);
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.writes.length === 1, "coalesce: the first match writes");
    h.clock.ms += 30_000;
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.writes.length === 1, "coalesce: a second match 30s later writes NOTHING — at most one row update per routine per minute");
    h.clock.ms += 40_000;
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.writes.length === 2, "coalesce: past the window the next match writes again");
    ok(h.writes[1]!.patch["lastMatchAt"] === "2026-07-28T09:01:10.000Z", "coalesce: the later write moves lastMatchAt forward");
    ok(
      h.writes[1]!.patch["firstMatchAt"] === undefined,
      "coalesce: …and does NOT re-write firstMatchAt — a row that already carries one keeps its first-EVER instant",
    );
    ok(r.firstMatchAt === "2026-07-28T09:00:00.000Z" && r.lastMatchAt === "2026-07-28T09:01:10.000Z", "coalesce: the merged row carries the first instant and the latest one");
  }

  {
    const r = routine({ id: "r-stamp-firstever" });
    const h = stampHarness([r], ["me/proj"], Date.parse("2026-07-28T11:00:00.000Z"));
    await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.writes.length === 1 && h.writes[0]!.patch["firstMatchAt"] === "2026-07-28T11:00:00.000Z", "coalesce: a routine's FIRST-EVER match always writes — the throttle key is its own id");
  }
}

{
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const spendStore = await import("../agent/spend/store.js");
  const { periodOf } = await import("../agent/spend/spend.js");
  type SpendBudgets = import("../agent/spend/spend.js").SpendBudgets;

  let budgets: SpendBudgets = {};
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "dm-crit", match: "dm" })],
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadSpendBudgets: () => budgets,
  });

  const period = periodOf(new Date().toISOString());
  const pFor = (surface: string) =>
    ({ org: "acme", platform: "slack", workspace: "T1", surface, workspaceKey: "slack/T1", surfaceKey: `slack/T1/${surface}`, key: `slack/T1/${surface}` });

  budgets = { perSurface: { "slack/T1/C_OVER": { surfaceMonthlyTokens: 5 } } };
  await spendStore.recordSpend(pFor("C_OVER") as never, { period, usage: { inputTokens: 100 } });
  {
    const over = routine({ id: "r-evt-over", surfaceKey: "slack/T1/C_OVER", target: { channelId: "C_OVER" } });
    const under = routine({ id: "r-evt-under" });
    const h = harness([over, under]);
    const report = await fanOutDelivery(PR_BODY, "pull_request", undefined, h.deps);
    ok(h.fired.length === 1 && h.fired[0]!.auth.attributes[ROUTINE_MARKER.id] === "r-evt-under", "OPE-275: an over-budget event routine does NOT fire — and the gate is per ROUTINE, so the under-budget sibling matched by the same delivery still does");
    const skip = h.audited.find((e) => e.action === "routine.skip" && e.detail?.["routineId"] === "r-evt-over");
    ok(skip?.detail?.["reason"] === "over_budget", "OPE-275: the decline is an AUDITED `over_budget` skip — silently-not-firing and deliberately-skipping must never look the same from the outside");
    ok(typeof skip?.detail?.["budgetReason"] === "string", "OPE-275: …and the row carries the gate's own human-readable reason");
    ok(report.fired === 1 && report.skipped === 1, "OPE-275: the transport-visible report counts the decline as a skip, not a fire");
  }

  budgets = { perDomain: { "dm-crit": { surfaceMonthlyTokens: 5 } } };
  await spendStore.recordSpend(pFor("D_ME") as never, { period, usage: { inputTokens: 100 } });
  {
    const dmRoutine = routine({ id: "r-evt-dm", surfaceKey: "slack/T1/D_ME", target: { channelId: "D_ME" }, createdBy: "U_ME" });
    const h = harness([dmRoutine]);
    await fanOutDelivery(PR_BODY, "pull_request", undefined, { ...h.deps, confirmCreatorInternal: async () => true });
    ok(h.fired.length === 0, 'OPE-275: perDomain["dm"] ALONE declines a DM event routine whose surface breached it — the documented "everyone gets their own budget" config now gates this leg too');
    const skip = h.audited.find((e) => e.action === "routine.skip" && e.detail?.["routineId"] === "r-evt-dm");
    ok(skip?.detail?.["reason"] === "over_budget", "OPE-275: …as an audited over_budget skip");
  }
  {
    const dmRoutine = routine({ id: "r-evt-dm-ext", surfaceKey: "slack/T1/D_ME", target: { channelId: "D_ME" }, createdBy: "U_ME" });
    const h = harness([dmRoutine]);
    await fanOutDelivery(PR_BODY, "pull_request", undefined, { ...h.deps, confirmCreatorInternal: async () => false });
    ok(h.fired.length === 1, "OPE-275: the dm classification is trust-CONDITIONAL — a creator who cannot be positively verified classifies `public`, and the dm-only budget does not apply");
  }
  budgets = {};
}

await removeTempDir(dir);
console.log(`✓ event-fanout: ${passed} assertions passed`);
