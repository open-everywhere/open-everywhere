import { scopeGrantsRead } from "../agent/access/read-grant.js";
import {
  HISTORY_DETAIL_MAX_CHARS,
  HISTORY_MAX_DELIVERIES,
  WEBHOOK_HISTORY_READ,
  readDeliveryHistory,
  renderDeliveryHistory,
  type DeliveryHistoryDeps,
} from "../agent/control/delivery-history.js";
import { DELIVERY_ID_MAX_CHARS } from "../agent/routines/ingress.js";
import type { AuditEntry, AuditInput } from "../agent/operational/store.js";
import type { EffectiveAccess } from "../agent/access/resolver.js";
import type { Partition } from "../agent/memory/partition.js";
import type { Routine } from "../agent/routines/routine.js";
import type { WebhookHook } from "../agent/webhooks/config.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ORG = "acme";
const NOW = new Date("2026-07-28T12:00:00.000Z");
const at = (minsAgo: number): string => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();

const CANARY = "SENDER-AUTHORED-BODY-BYTES-a1b2c3";

const PARTITION: Partition = {
  org: ORG,
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  workspaceKey: "slack/T1",
  surfaceKey: "slack/T1/C1",
  key: "slack/T1/C1",
};

const access = (domains: readonly string[]): EffectiveAccess =>
  ({
    mode: "channel",
    scopeKey: "slack/T1/C1",
    domains,
    tenantKey: "slack/T1",
    surfaceKey: "slack/T1/C1",
  }) as unknown as EffectiveAccess;

const CONFIG_HOOK: WebhookHook = {
  id: "deploy-status",
  source: "oe-standard-webhook",
  secretRef: "DEPLOY_STATUS_WEBHOOK_SECRET",
  broker: "env",
  target: "slack/T1/C1",
  instruction: "summarise the deploy",
  readableBy: [{ level: "domain", domain: "payments" }],
} as unknown as WebhookHook;

const routine = (id: string, source: string, over: Partial<Routine> = {}): Routine =>
  ({
    id,
    org: ORG,
    surfaceKey: "slack/T1/C1",
    status: "active",
    trigger: { kind: "event", source, jq: ".event == \"push\"" },
    instruction: "do the thing",
    ...over,
  }) as unknown as Routine;

const row = (action: string, ts: string, detail: Record<string, unknown>): AuditEntry => ({
  ts,
  org: ORG,
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  action,
  detail: { ...detail, body: CANARY, payload: CANARY, rawBody: CANARY },
});

interface Harness {
  readonly deps: DeliveryHistoryDeps;
  readonly written: AuditInput[];
}

function harness(over: {
  rows?: Record<string, AuditEntry[]>;
  routines?: Routine[];
  config?: readonly WebhookHook[];
  domains?: readonly string[];
  throwOnResolve?: boolean;
}): Harness {
  const written: AuditInput[] = [];
  const rows = over.rows ?? {};
  return {
    written,
    deps: {
      configHooks: () => over.config ?? [CONFIG_HOOK],
      routines: async () => over.routines ?? [],
      read: async (f = {}) => (rows[f.action ?? ""] ?? []) as AuditEntry[],
      audit: async (e) => {
        written.push(e);
      },
      resolve: () => {
        if (over.throwOnResolve) throw new Error("config would not load");
        return access(over.domains ?? ["payments"]);
      },
      now: () => NOW,
    },
  };
}

{
  const h = harness({
    rows: {
      "webhook.fired": [row("webhook.fired", at(5), { hookId: "deploy-status", bytes: 812, matched: 2, fired: 2, skipped: 0, deliveryId: "d-1" })],
    },
    routines: [routine("r-aaaa", "deploy-status")],
  });
  const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
  ok(res.ok, "1a: a granted read succeeds");
  if (!res.ok) process.exit(1);
  ok(res.history.deliveries.length === 1, "1b: the delivery comes back");
  ok(res.history.deliveries[0].outcome === "fired" && res.history.deliveries[0].bytes === 812, "1c: outcome + byte COUNT");
  ok(res.history.deliveries[0].deliveryId === "d-1", "1d: the sender's delivery id is carried");
  ok(res.history.deliveries[0].verification === "signed", "1e: an unstamped delivery reads as signed");
  ok(res.history.totals.accepted === 1 && res.history.totals.rejected === 0, "1f: totals");
  ok(res.history.subscribers.length === 1 && res.history.subscribers[0].routineId === "r-aaaa", "1g: the subscriber is resolved from its trigger");
}

{
  const h = harness({
    rows: {
      "webhook.rejected": [row("webhook.rejected", at(3), { hookId: "deploy-status", status: 401, reason: "bad signature", suppressed: 41 })],
    },
  });
  const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
  ok(res.ok, "2a: read ok");
  if (!res.ok) process.exit(1);
  const d = res.history.deliveries[0];
  ok(d.outcome === "rejected" && d.status === 401, "2b: a rejection is a delivery the history shows");
  ok(d.verification === "refused", "2c: a rejected delivery is graded refused, not signed");
  ok(d.matched === null && d.fired === null, "2d: fan-out fields are NULL, not 0 — 'we never asked' is not 'nothing matched'");
  ok(d.standsFor === 41, "2e: the throttle's suppression count survives into the read model");
  ok(res.history.totals.rejected === 1, "2f: rejections are counted separately from accepted deliveries");
}

{
  const h = harness({
    rows: {
      "webhook.fired": [row("webhook.fired", at(2), { hookId: "deploy-status", bytes: 40, matched: 0, fired: 0, skipped: 0 })],
      "webhook.declined": [row("webhook.declined", at(1), { hookId: "deploy-status", bytes: 40, matched: 0, fired: 0, skipped: 0, routingReason: "source does not model this event" })],
    },
  });
  const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
  ok(res.ok, "3a: read ok");
  if (!res.ok) process.exit(1);
  ok(res.history.totals.matchedNothing === 2, "3b: 'the hook works, the filter does not' is a counted outcome");
  const declined = res.history.deliveries.find((x) => x.outcome === "declined");
  ok(declined?.reason === "source does not model this event", "3c: the EVENT PLANE's own refusal reaches the reader (the config path used to drop it)");
  ok(renderDeliveryHistory(res.history).includes("matched no routine"), "3d: the rendering names the case");
}

{
  const h = harness({
    rows: {
      "webhook.fired": [row("webhook.fired", at(9), { hookId: "deploy-status", bytes: 100, matched: 1, fired: 0, skipped: 1 })],
      "routine.skip": [
        row("routine.skip", at(8), { routineId: "r-aaaa", reason: "grant_refused", grant: "refused", partition: "slack/T1/C1", suppressed: 7 }),
      ],
      "routine.fire_lost": [row("routine.fire_lost", at(7), { routineId: "r-aaaa", error: "channel_not_found" })],
    },
    routines: [routine("r-aaaa", "deploy-status")],
  });
  const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
  ok(res.ok, "4a: read ok");
  if (!res.ok) process.exit(1);
  const s = res.history.subscribers[0];
  ok(s.misses.length === 2, "4b: both a skip and a lost fire are misses");
  ok(s.misses[0].at > s.misses[1].at, "4b2: misses come back newest-first");
  const refused = s.misses.find((m) => m.reason === "grant_refused");
  const lost = s.misses.find((m) => m.reason === "fire_lost");
  ok(refused !== undefined, "4c: the zero-domain-class refusal is visible BY NAME (OPE-206 bonus)");
  ok(refused?.standsFor === 7, "4d: the skip throttle's count survives");
  ok(lost?.detail === "channel_not_found", "4e: a lost fire is reported with its error");
  ok(s.fires === 0, "4f: a matched-but-refused routine has zero fires — the two are not conflated");
}

{
  const h = harness({ domains: ["support"] });
  const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
  ok(!res.ok && res.reason === "not-readable", "5a: an ungranted surface is refused");
  if (res.ok) process.exit(1);
  ok(res.message.includes('domain "payments"'), "5b: the refusal RENDERS the grant rather than being a bare no");

  const dead = { ...CONFIG_HOOK, readableBy: [] } as unknown as WebhookHook;
  const h2 = harness({ config: [dead] });
  const res2 = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h2.deps);
  ok(!res2.ok && !res2.ok && res2.message.includes("NOBODY"), "5c: a zero-grant hook says NOBODY can read it, instead of failing silently forever");

  const h3 = harness({ throwOnResolve: true });
  const res3 = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h3.deps);
  ok(!res3.ok && res3.reason === "not-readable", "5d: a resolver failure fails CLOSED");

  const h4 = harness({});
  const res4 = await readDeliveryHistory({ partition: PARTITION, source: "no-such-hook" }, h4.deps);
  ok(!res4.ok && res4.reason === "unknown-hook", "5e: an unknown handle is refused");
  ok(h4.written.length === 0, "5f: …and writes NO audit row (no caller-chosen label enters a permanent table)");
}

{
  const cases: { readableBy: WebhookHook["readableBy"]; domains: string[] }[] = [
    { readableBy: [{ level: "org" }], domains: [] },
    { readableBy: [{ level: "domain", domain: "payments" }], domains: ["payments"] },
    { readableBy: [{ level: "domain", domain: "payments" }], domains: ["support"] },
    { readableBy: [{ level: "tenant", tenant: "slack/T1" }], domains: [] },
    { readableBy: [{ level: "tenant", tenant: "slack/T9" }], domains: [] },
    { readableBy: [{ level: "surface", surface: "slack/T1/C1" }], domains: [] },
    { readableBy: [{ level: "surface", surface: "slack/T1/C9" }], domains: [] },
    { readableBy: [{ level: "principal", principal: "U1" }], domains: [] },
    { readableBy: [], domains: ["payments"] },
  ] as never;
  for (const [i, c] of cases.entries()) {
    const hook = { ...CONFIG_HOOK, readableBy: c.readableBy } as unknown as WebhookHook;
    const h = harness({ config: [hook], domains: c.domains });
    const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
    const fireVerdict = scopeGrantsRead(c.readableBy, access(c.domains));
    ok(res.ok === fireVerdict, `6.${i}: read verdict matches the FIRE gate's scopeGrantsRead verdict`);
  }
}

{
  const h = harness({
    rows: {
      "webhook.fired": [row("webhook.fired", at(5), { hookId: "deploy-status", bytes: 812, matched: 1, fired: 1, skipped: 0, deliveryId: "d-1" })],
      "webhook.declined": [row("webhook.declined", at(4), { hookId: "deploy-status", bytes: 9, matched: 0, fired: 0, skipped: 0, reason: "over budget" })],
      "webhook.rejected": [row("webhook.rejected", at(3), { hookId: "deploy-status", status: 413, reason: "payload exceeds 1048576 bytes" })],
      "routine.fire": [row("routine.fire", at(5), { routineId: "r-aaaa", sessionId: "s-1", outcome: "ok" })],
      "routine.skip": [row("routine.skip", at(6), { routineId: "r-aaaa", reason: "filter_invalid", why: "jq: error: Unknown function", filter: ".x" })],
      "routine.fire_lost": [row("routine.fire_lost", at(7), { routineId: "r-aaaa", error: "boom" })],
    },
    routines: [routine("r-aaaa", "deploy-status")],
  });
  const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
  ok(res.ok, "7a: read ok");
  if (!res.ok) process.exit(1);
  const serialized = JSON.stringify(res.history) + "\n" + renderDeliveryHistory(res.history) + "\n" + JSON.stringify(h.written);
  ok(!serialized.includes(CANARY), "7b: NO body-shaped detail key reaches the result, the rendering, or the read's own audit row");
  ok(serialized.includes("812"), "7c: …while the byte COUNT does (this is metadata, not a body)");

  const long = "x".repeat(HISTORY_DETAIL_MAX_CHARS + 500);
  const h2 = harness({
    rows: { "routine.skip": [row("routine.skip", at(6), { routineId: "r-aaaa", reason: "filter_invalid", why: long })] },
    routines: [routine("r-aaaa", "deploy-status")],
  });
  const res2 = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h2.deps);
  ok(res2.ok, "7d: read ok");
  if (!res2.ok) process.exit(1);
  ok(res2.history.subscribers[0].misses[0].detail?.length === HISTORY_DETAIL_MAX_CHARS, "7e: an off-host evaluator message is length-capped");
}

{
  const many = Array.from({ length: 200 }, (_, i) =>
    row("webhook.fired", at(i + 1), { hookId: "deploy-status", bytes: 10, matched: 1, fired: 1, skipped: 0 }),
  );
  const manySkips = Array.from({ length: 50 }, (_, i) => row("routine.skip", at(i + 1), { routineId: "r-aaaa", reason: "fanout_cap" }));
  const h = harness({
    rows: { "webhook.fired": many, "routine.skip": manySkips },
    routines: [routine("r-aaaa", "deploy-status")],
  });
  const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
  ok(res.ok, "8a: read ok");
  if (!res.ok) process.exit(1);
  ok(h.written.length === 1, "8b: 250 rows read ⇒ EXACTLY ONE audit row written (no per-delivery amplifier)");
  ok(h.written[0].action === WEBHOOK_HISTORY_READ, "8c: …and it is the self-audit row");
  ok(h.written[0].detail?.["granted"] === true, "8d: the row records the verdict");
  ok(res.history.deliveries.length === HISTORY_MAX_DELIVERIES && res.history.moreDeliveries, "8e: the returned page is bounded and says it is truncated");
  ok(res.history.totals.accepted === 200, "8f: …while the TOTAL is over the whole window, not the page");

  const h2 = harness({ domains: ["support"] });
  await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h2.deps);
  ok(h2.written.length === 1 && h2.written[0].detail?.["granted"] === false, "8g: a refused read is audited, with granted:false");
}

{
  const known = new Set([
    "fanout_cap",
    "over_budget",
    "unresolved_target",
    "filter_invalid",
    "grant_refused",
    "grant_drift",
    "audience_floor",
    "fire_lost",
  ]);
  const skips = [...known]
    .filter((r) => r !== "fire_lost")
    .map((r, i) => row("routine.skip", at(i + 1), { routineId: "r-aaaa", reason: r }));
  const h = harness({
    rows: { "routine.skip": skips, "routine.fire_lost": [row("routine.fire_lost", at(99), { routineId: "r-aaaa", error: "x" })] },
    routines: [routine("r-aaaa", "deploy-status")],
  });
  const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
  ok(res.ok, "9a: read ok");
  if (!res.ok) process.exit(1);
  const reasons = res.history.subscribers[0].misses.map((m) => m.reason);
  ok(reasons.length > 0 && reasons.every((r) => known.has(r)), "9b: every surfaced reason is a value an existing writer emits — none invented here");
}

{
  const h = harness({
    rows: { "routine.skip": [row("routine.skip", at(5), { routineId: "r-aaaa", reason: "grant_refused", suppressed: 99 })] },
    routines: [routine("r-aaaa", "deploy-status")],
  });
  const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
  ok(res.ok, "10a: read ok");
  if (!res.ok) process.exit(1);
  ok(res.history.throttled, "10b: the history declares that it contains stood-in-for rows");
  const text = renderDeliveryHistory(res.history);
  ok(text.includes("+99 suppressed"), "10c: the count is rendered");
  ok(text.includes("not proof"), "10d: …and the rendering says the ABSENCE of a row proves nothing");

  const h2 = harness({
    rows: { "routine.skip": [row("routine.skip", at(5), { routineId: "r-aaaa", reason: "grant_refused" })] },
    routines: [routine("r-aaaa", "deploy-status")],
  });
  const res2 = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h2.deps);
  ok(res2.ok && !res2.history.throttled, "10e: an unthrottled window is not annotated as throttled");
}

{
  const h = harness({
    rows: {
      "webhook.fired": [row("webhook.fired", at(5), { hookId: "deploy-status", source: "deploy-status", bytes: 12, matched: 0, fired: 0, skipped: 0 })],
    },
  });
  const unknown = await readDeliveryHistory({ partition: PARTITION, source: "vendor-alerts" }, h.deps);
  ok(!unknown.ok && unknown.reason === "unknown-hook", "11a: a handle no declaration carries is UNKNOWN — with one registry there is no second store that might still have it");

  const res = await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h.deps);
  ok(res.ok, "11b: a declared hook is addressable by the handle a routine subscribes to");
  if (!res.ok) process.exit(1);
  ok(res.history.hookClass === "config" && res.history.source === "deploy-status", "11c: class + handle");
  const out = JSON.stringify(res.history) + renderDeliveryHistory(res.history);
  ok(!out.includes("DEPLOY_STATUS_WEBHOOK_SECRET"), "🔴 11d: the SECRET REF never reaches the model-facing result — a pointer straight at the vault row is the thing that still must not travel");
}

{
  ok(DELIVERY_ID_MAX_CHARS > 0 && DELIVERY_ID_MAX_CHARS <= 1000, "12a: a sender-supplied delivery id has a stated bound before it enters a permanent row");
}

{
  const h = harness({
    rows: { "webhook.fired": [row("webhook.fired", at(5), { hookId: "deploy-status", bytes: 10, matched: 1, fired: 1, skipped: 0 })] },
  });
  await readDeliveryHistory({ partition: PARTITION, source: "deploy-status", principalId: "U_READER" }, h.deps);
  ok(h.written.length === 1 && h.written[0].principalId === "U_READER", "13a: 🔴 the history read's audit row NAMES the reader — an unattributed row cannot answer 'who ran this'");

  const h2 = harness({ domains: ["support"] });
  await readDeliveryHistory({ partition: PARTITION, source: "deploy-status", principalId: "U_NOSY" }, h2.deps);
  ok(h2.written.length === 1 && h2.written[0].principalId === "U_NOSY" && h2.written[0].detail?.["granted"] === false, "13b: …and a REFUSED read is attributed too, which is the row worth counting per person");

  const h3 = harness({ rows: {} });
  await readDeliveryHistory({ partition: PARTITION, source: "deploy-status" }, h3.deps);
  ok(h3.written.length === 1 && h3.written[0].principalId === undefined, "13c: an unattributable caller still writes the row (the field is omitted, the record is not)");
}

console.log(`✓ webhook-history-test: ${passed} assertions passed`);
