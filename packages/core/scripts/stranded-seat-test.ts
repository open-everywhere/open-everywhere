// proves: SEAT-68, SEAT-69

import { mkdtempSync } from "node:fs";
import { eveWorldVercelSource } from "./_eve-world-source.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-stranded-seat-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
import {
  isPrunedDeploymentWakeError,
  prunedDeploymentIds,
  healPrunedDeploymentStrand,
  RUN_KEY_FETCH_MARKER,
  DEPLOYMENT_GONE_MARKER,
  HTTP_404_MARKER,
  PRUNED_DEPLOYMENT_AUDIT_ACTION,
} from "../agent/channels/stranded-seat.js";
import { divertToUnifiedWindow } from "../agent/channels/unified.js";
import { formatWindowToken } from "../agent/channels/window-key.js";
import { unifiedDomainSessionKey } from "../agent/channels/unified-supervisor.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { deploymentOrg } from "../agent/identity/binding.js";
import { readAudit } from "../agent/audit/audit.js";
import type { RouteHandlerArgs } from "eve/channels";
import { registerSlackFixtureMapper, registerSlackFixtureCodec } from "./_slack-test-stubs.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
registerSlackFixtureMapper();
registerSlackFixtureCodec();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), label);

const REAL_MESSAGE =
  'Failed to fetch run key for wrun_01AAAAAAAAAAAAAAAAAAAAAAAA (deployment dpl_AAAAAAAAAAAAAAAAAAAAAAAAAAAA): HTTP 404 Not Found — {"error":{"code":"not_found","message":"Deployment not found."}}';

const REAL_TOKEN = "oe-dom:oe-dm/slack/T0AAAAAAA/D0AAAAAAAAA:oe-sup:g1787247382196-aaaaaa";
const REAL_REGISTRY_KEY = "oe-domain::oe-dm/slack/T0AAAAAAA/D0AAAAAAAAA";

{
  ok(isPrunedDeploymentWakeError(REAL_MESSAGE), "positive: the verbatim prod message classifies as a pruned-deployment strand");
  ok(isPrunedDeploymentWakeError(new Error(REAL_MESSAGE)), "positive: the same message inside an Error classifies");
  const wrapped = new Error("dispatchContinuation failed", { cause: new Error(REAL_MESSAGE) });
  ok(isPrunedDeploymentWakeError(wrapped), "positive: the message reached through a `cause` chain still classifies");
  ok(
    isPrunedDeploymentWakeError(`${RUN_KEY_FETCH_MARKER} for wrun_X (deployment dpl_Y): ${HTTP_404_MARKER} Not Found`),
    "positive: the status line alone satisfies the second marker when the body is missing",
  );
}

{
  const recoverable: readonly string[] = [
    'Failed to fetch run key for wrun_X (deployment dpl_Y): HTTP 500 Internal Server Error — {"error":"oops"}',
    "Failed to fetch run key for wrun_X (deployment dpl_Y): HTTP 503 Service Unavailable",
    "Cannot fetch run key: no OIDC token or VERCEL_TOKEN available",
  ];
  for (const m of recoverable) {
    ok(isPrunedDeploymentWakeError(m) === false, `negative (recoverable run-key failure): ${JSON.stringify(m.slice(0, 60))}… classifies FALSE`);
  }

  ok(isPrunedDeploymentWakeError(RUN_KEY_FETCH_MARKER) === false, "negative (half-match): the run-key marker WITHOUT a 404 marker classifies FALSE");
  ok(
    isPrunedDeploymentWakeError(`GET /api/thing: ${HTTP_404_MARKER} Not Found — ${DEPLOYMENT_GONE_MARKER}`) === false,
    "negative (half-match): a 404 that is NOT a run-key fetch classifies FALSE",
  );

  ok(
    isPrunedDeploymentWakeError("Event id is not slot-numbered: evnt_01K2. This World allocates event positions the runtime cannot read.") === false,
    "negative (sibling class): the unresumable-World sentence classifies FALSE here",
  );

  for (const m of ["fetch failed", "socket hang up", "ETIMEDOUT", "AI_APICallError: Gateway timeout", ""]) {
    ok(isPrunedDeploymentWakeError(m) === false, `negative (transient): ${JSON.stringify(m)} classifies FALSE`);
  }
  for (const v of [undefined, null, 0, 1, {}, [], true] as readonly unknown[]) {
    ok(isPrunedDeploymentWakeError(v) === false, `negative (shape): ${JSON.stringify(v) ?? "undefined"} classifies FALSE`);
  }
}

{
  eq(
    prunedDeploymentIds(new Error(REAL_MESSAGE)),
    { runId: "wrun_01AAAAAAAAAAAAAAAAAAAAAAAA", deploymentId: "dpl_AAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    "ids: the run id and deployment id are recovered from the real message for the audit row",
  );
  eq(prunedDeploymentIds("nothing to see"), {}, "ids: an unparseable message yields an empty object, never a partial guess");
}

interface MarkCall {
  readonly org: string;
  readonly key: string;
  readonly at: string;
}
interface AuditRow {
  readonly action: string;
  readonly detail: Record<string, unknown>;
  readonly surface?: string;
  readonly workspace?: string;
}
function fakeAudit() {
  const rows: AuditRow[] = [];
  return { rows, audit: async (e: { action: string; detail?: unknown; surface?: string; workspace?: string }) => {
    rows.push({ action: e.action, detail: (e.detail ?? {}) as Record<string, unknown>, surface: e.surface, workspace: e.workspace });
  } };
}
function fakeStore(result: boolean | "throw") {
  const calls: MarkCall[] = [];
  return {
    calls,
    store: {
      async markChannelSessionRotation(org: string, key: string, at: string): Promise<boolean> {
        calls.push({ org, key, at });
        if (result === "throw") throw new Error("store down");
        return result;
      },
    },
  };
}
const AT = "2026-04-04T09:01:22.401Z";
const base = { surfaceKey: "slack/T0AAAAAAA/D0AAAAAAAAA", platform: "slack", atIso: AT, org: "default" } as const;

{
  const f = fakeStore(true);
  const a = fakeAudit();
  const outcome = await healPrunedDeploymentStrand({ ...base, token: REAL_TOKEN, err: new Error(REAL_MESSAGE), store: f.store, audit: a.audit });
  ok(outcome === "marked", "heal: the incident's own message marks the seat for rotation");
  ok(f.calls.length === 1, "heal: exactly ONE mark is written");
  ok(a.rows.length === 1, "heal: exactly ONE audit row is written");
  eq(a.rows[0].action, PRUNED_DEPLOYMENT_AUDIT_ACTION, "audit: the row carries the class's own action");
  eq(a.rows[0].detail.remedy, "rotate-at-next-wake", "audit: the row states the remedy in one word");
  eq(a.rows[0].detail.registryKey, REAL_REGISTRY_KEY, "audit: the row names the registry key that was marked");
  eq(a.rows[0].detail.deploymentId, "dpl_AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "audit: the row names the pruned deployment, so the incident is diagnosable from the control plane");
  eq(a.rows[0].surface, base.surfaceKey, "audit: the row is partitioned on the woken surface");
  eq(f.calls[0].key, REAL_REGISTRY_KEY, "heal: the mark lands on the DM seat's own registry key, derived from the token alone");
  eq(f.calls[0].org, "default", "heal: the mark lands on the caller's org");
  eq(f.calls[0].at, AT, "heal: the mark carries the wake's own timestamp");
}
{
  const f = fakeStore(true);
  const outcome = await healPrunedDeploymentStrand({ ...base, token: REAL_TOKEN, err: new Error("socket hang up"), store: f.store });
  ok(outcome === "not-classified", "heal (negative control): an unrelated failure classifies not-classified");
  ok(f.calls.length === 0, "heal (negative control): an unrelated failure writes NOTHING to the store — the seat keeps its context");
  const a2 = fakeAudit();
  await healPrunedDeploymentStrand({ ...base, token: REAL_TOKEN, err: new Error("socket hang up"), store: f.store, audit: a2.audit });
  ok(a2.rows.length === 0, "heal (negative control): an unrelated failure writes NO audit row either");
}
{
  const f = fakeStore(false);
  const outcome = await healPrunedDeploymentStrand({ ...base, token: REAL_TOKEN, err: new Error(REAL_MESSAGE), store: f.store, audit: async () => {} });
  ok(outcome === "no-row", "heal: a seat with no channel_session row reports no-row (the mark never creates one)");
  ok(f.calls.length === 1, "heal: the store was still asked — `no-row` is the store's answer, not a guess");
}
{
  const f = fakeStore(true);
  const a = fakeAudit();
  const outcome = await healPrunedDeploymentStrand({ ...base, token: "C0123456:1755227640.000100", err: new Error(REAL_MESSAGE), store: f.store, audit: a.audit });
  ok(outcome === "not-a-window", "heal: a non-window token reports not-a-window");
  ok(f.calls.length === 0, "heal: a non-window token writes NOTHING — no phantom registry row");
  eq(a.rows[0].detail.remedy, "none", "audit: an unhealable token still gets a row, and the row says the remedy is NONE — visible instead of silent");
}
const NATIVE_TOKEN = "C0123456:oe-sup:g1";
{
  const f = fakeStore(true);
  const a = fakeAudit();
  const outcome = await healPrunedDeploymentStrand({
    ...base,
    token: NATIVE_TOKEN,
    registryKey: "slack/T0AAAAAAA/C0123456",
    workspace: "T0AAAAAAA",
    err: new Error(REAL_MESSAGE),
    store: f.store,
    audit: a.audit,
  });
  ok(outcome === "marked", "🔴 OPE-971: an explicit registryKey override marks the seat even though the token itself does not parse as a window");
  ok(f.calls.length === 1, "…exactly ONE mark is written");
  eq(f.calls[0].key, "slack/T0AAAAAAA/C0123456", "…and it lands on the OVERRIDE key, not any token-derived guess");
  eq(a.rows[0].detail.registryKey, "slack/T0AAAAAAA/C0123456", "…the audit row names the override key");
  eq(a.rows[0].workspace, "T0AAAAAAA", "…and the override workspace wins over the token-derived (absent) domain");
  eq(a.rows[0].detail.remedy, "rotate-at-next-wake", "…the remedy is the real one, not `none`");
}
{
  const f = fakeStore(true);
  const a = fakeAudit();
  const outcome = await healPrunedDeploymentStrand({ ...base, token: NATIVE_TOKEN, err: new Error(REAL_MESSAGE), store: f.store, audit: a.audit });
  ok(outcome === "not-a-window", "OPE-971 negative control: the SAME native token WITHOUT the override still resolves not-a-window — the override is additive");
  ok(f.calls.length === 0, "…and writes NOTHING — the pre-971 call site's behaviour is untouched");
  eq(a.rows[0].workspace, "unknown", "…the audit row falls back to `unknown`, exactly as before the override existed");
}
{
  const f = fakeStore("throw");
  const outcome = await healPrunedDeploymentStrand({ ...base, token: REAL_TOKEN, err: new Error(REAL_MESSAGE), store: f.store, audit: async () => {} });
  ok(outcome === "failed", "heal: a throwing store reports failed rather than propagating — the caller's own error must survive");
}
{
  ok(PRUNED_DEPLOYMENT_AUDIT_ACTION === "session.pruned_deployment_strand", "audit: the action name is the stable string the control plane queries");
}

{
  const haystack = eveWorldVercelSource();
  ok(
    haystack.includes(RUN_KEY_FETCH_MARKER),
    "pin: RUN_KEY_FETCH_MARKER is still present in the installed eve runtime — if this is RED, eve re-worded the message and isPrunedDeploymentWakeError no longer matches it",
  );
  ok(
    haystack.includes("/v1/workflow/run-key/"),
    "pin: eve still fetches the run key per DEPLOYMENT from the Vercel API — the whole strand depends on that deployment-scoped lookup",
  );
}

{
  const org = deploymentOrg();
  const store = getOperationalStore();
  const DOMAIN = "payments";
  const token = formatWindowToken({ domain: DOMAIN, windowId: DOMAIN, generation: 3 });
  const registryKey = unifiedDomainSessionKey(DOMAIN);
  await store.rotateChannelSession(org, registryKey, token, "2026-04-04T08:00:00.000Z");
  const before = await store.getChannelSession(org, registryKey);
  ok(before?.rotateMarkedAt == null, "wiring precondition: the seat starts UNMARKED (so a green below cannot be vacuous)");

  const failingReceive = ((_ch: unknown, _target: unknown) => ({
    async send(): Promise<never> {
      throw new Error(REAL_MESSAGE);
    },
  })) as unknown as RouteHandlerArgs["to"];

  let threw: unknown;
  try {
    await divertToUnifiedWindow(failingReceive, {
      message: "<wake>hello</wake>",
      token,
      window: { wakeId: "w1", origin: { platform: "slack", channelId: "C1" }, addressing: "direct-mention" },
      surfaceKey: "slack/T1/C1",
      auth: { attributes: { team_id: "T1", channel_id: "C1" } },
    });
  } catch (err) {
    threw = err;
  }
  ok(threw !== undefined, "wiring: the divert still RETHROWS — the surface's own wake_failed record is untouched");
  ok(isPrunedDeploymentWakeError(threw), "wiring: the rethrown error is the original one, not the heal's");

  const after = await store.getChannelSession(org, registryKey);
  ok(after?.rotateMarkedAt != null, "🔴 wiring: the live divert MARKED the seat for rotation — the next wake rotates into a fresh run");
  const rows = await readAudit({ org, action: PRUNED_DEPLOYMENT_AUDIT_ACTION });
  ok(rows.length === 1, "wiring: the live divert wrote exactly one strand audit row");

  await store.rotateChannelSession(org, registryKey, token, "2026-04-04T08:30:00.000Z");
  const healthyReceive = ((_ch: unknown, _target: unknown) => ({
    async send(): Promise<never> {
      throw new Error("socket hang up");
    },
  })) as unknown as RouteHandlerArgs["to"];
  await divertToUnifiedWindow(healthyReceive, {
    message: "<wake>hello</wake>",
    token,
    window: { wakeId: "w2", origin: { platform: "slack", channelId: "C1" }, addressing: "direct-mention" },
    surfaceKey: "slack/T1/C1",
    auth: { attributes: { team_id: "T1", channel_id: "C1" } },
  }).catch(() => undefined);
  const stillHealthy = await store.getChannelSession(org, registryKey);
  ok(stillHealthy?.rotateMarkedAt == null, "🔴 wiring (negative control): a TRANSIENT send failure marks NOTHING — a live seat keeps its context");
  ok((await readAudit({ org, action: PRUNED_DEPLOYMENT_AUDIT_ACTION })).length === 1, "wiring (negative control): and writes no second strand row");
}

console.log(`✓ stranded-seat: ${passed} assertions passed`);
