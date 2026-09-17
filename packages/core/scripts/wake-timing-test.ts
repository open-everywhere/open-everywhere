import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-wake-timing-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { readAudit } from "../agent/audit/audit.js";
import turnStartHook from "../agent/hooks/wake-turn-start.js";
import {
  slackVendorEventTime,
  discordVendorEventTime,
  vendorInstantEventTime,
  receiptEventTime,
  spreadVendorTs,
  wakeIngressDetail,
  splitWakeLatency,
  renderWakeSplit,
  WAKE_TURN_START_ACTION,
  WAKE_RETRY_ACTION,
  WAKE_DISPATCH_RETRY_POLICY,
  wakeRetryDetail,
} from "../agent/channels/wake-timing.js";
import { readWakeSplits, summariseWakeSplits } from "./e2e/wake-split.js";
import { registerSlackFixtureMapper, registerSlackFixtureCodec } from "./_slack-test-stubs.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

registerSlackFixtureMapper();
registerSlackFixtureCodec();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "payments", reach: ["slack/T_TIME/C_TIME"], ambientSupervisor: true, mode: "unified" })],
  loadSilos: () => [],
  domainsForSurface: () => ["payments"],
});

console.log("1. vendor-clock readers:");
eq(slackVendorEventTime("1757665614.000200"), { ms: 1_757_665_614_000, source: "slack-ts" }, "a Slack ts reads as its own send time, to the millisecond");
eq(slackVendorEventTime("1757665614.500000")?.ms, 1_757_665_614_500, "the microsecond tail lands in the milliseconds rather than rounding the second away");
for (const bad of [undefined, "", "not-a-ts", "0", ".123", "99999999999999999999.000000"]) {
  eq(slackVendorEventTime(bad), undefined, `an unusable Slack ts (${JSON.stringify(bad)}) reads as NO reading, never as a bad one`);
}
eq(discordVendorEventTime("99999999999999999999999"), undefined, "a snowflake past the representable Date range reads as NO reading, so no row build can throw on it");
eq(vendorInstantEventTime("1970-01-01T00:00:00.100Z"), undefined, "a 1970 vendor stamp is below the floor — it is a broken field, not a 56-year delivery");
const snowflake = discordVendorEventTime("1300000000000000101");
eq(snowflake?.source, "discord-snowflake", "a snowflake names its own source");
eq(snowflake?.ms, Number((1300000000000000101n >> 22n) + 1420070400000n), "a snowflake's time is its top 42 bits above the Discord epoch");
ok((snowflake?.ms ?? 0) > 1_700_000_000_000, "the snowflake resolves to a real recent instant, not to 1970 (the sign a Number parse lost the low bits)");
for (const bad of [undefined, "", "not-a-snowflake", "12x34"]) {
  eq(discordVendorEventTime(bad), undefined, `a non-numeric Discord id (${JSON.stringify(bad)}) reads as NO reading`);
}
eq(vendorInstantEventTime("2026-09-12T12:00:00.000Z"), { ms: Date.parse("2026-09-12T12:00:00.000Z"), source: "vendor-time" }, "a vendor ISO stamp reads as a vendor time");
eq(vendorInstantEventTime("garbage"), undefined, "an unparseable ISO stamp reads as NO reading");
eq(receiptEventTime(1_757_601_240_000), { ms: 1_757_601_240_000, source: "receipt" }, "our own front-door instant is marked `receipt`, never as a vendor reading");
eq(spreadVendorTs(undefined), {}, "no reading spreads to NOTHING — the optional field stays absent rather than becoming `undefined`");
eq(spreadVendorTs({ ms: 5, source: "receipt" }), { vendorTs: { ms: 5, source: "receipt" } }, "a reading spreads under `vendorTs`");

console.log("2. wakeIngressDetail:");
const VENDOR_MS = Date.parse("2026-09-12T12:00:00.000Z");
const INGRESS_MS = VENDOR_MS + 9_400;
const withVendor = wakeIngressDetail({
  wakeId: "wk-1",
  deliveryId: "dl-1",
  surfaceKey: "slack/T_TIME/C_TIME",
  vendor: { ms: VENDOR_MS, source: "slack-ts" },
  ingressMs: INGRESS_MS,
});
eq(withVendor.wakeId, "wk-1", "the row carries the wake id — the join key to the turn-start row and to reply.post");
eq(withVendor.deliveryId, "dl-1", "the row carries the delivery nonce, so a redrive of one wake id is still tellable apart");
eq(withVendor.surfaceKey, "slack/T_TIME/C_TIME", "the row names the container the wake arrived in");
eq(withVendor.vendorTs, "2026-09-12T12:00:00.000Z", "the row carries the VENDOR's own instant");
eq(withVendor.vendorTsSource, "slack-ts", "the row says HOW that instant was read, so a reader never has to guess what it means");
eq(withVendor.ingressTs, new Date(INGRESS_MS).toISOString(), "the row carries the ingress receipt instant");
eq(withVendor.vendorToIngressMs, 9_400, "vendor→ingress is the difference of the two anchors");
const noVendor = wakeIngressDetail({ wakeId: "wk-2", surfaceKey: "slack/T_TIME/C_TIME", ingressMs: INGRESS_MS });
eq(noVendor.vendorTs, undefined, "no vendor reading ⇒ NO vendorTs (never epoch zero)");
eq(noVendor.vendorTsSource, undefined, "no vendor reading ⇒ no source claim");
eq(noVendor.vendorToIngressMs, undefined, "no vendor reading ⇒ NO derived gap — a 0 would report an instant delivery that never happened");
eq(noVendor.deliveryId, undefined, "an omitted delivery nonce stays absent rather than becoming `undefined`");
ok(noVendor.ingressTs.length > 0, "the ingress instant rides EVERY row — it is the row's own reason to exist");
eq(
  wakeIngressDetail({ wakeId: "wk-3", surfaceKey: "s", vendor: { ms: INGRESS_MS + 500, source: "vendor-time" }, ingressMs: INGRESS_MS }).vendorToIngressMs,
  -500,
  "a vendor clock AHEAD of ours reports a negative gap rather than a clamped zero (a clamp would read as a fast delivery)",
);
eq(
  Object.keys(withVendor).sort(),
  ["deliveryId", "ingressTs", "surfaceKey", "vendorToIngressMs", "vendorTs", "vendorTsSource", "wakeId"],
  "the row's keys are exactly the ids and timestamps — no message text, no author, no channel name",
);

console.log("3. hooks/wake-turn-start turn.started:");
const turnStarted = (turnStartHook as { events: { "turn.started": (e: unknown, ctx: unknown) => Promise<void> } }).events["turn.started"];
const ctxFor = (wakeId: string | undefined) => ({
  channel: { kind: "slack", continuationToken: "oe-dom:payments:oe-sup:g1" },
  session: {
    id: "wrun_time_1",
    auth: {
      current: {
        attributes: {
          team_id: "T_TIME",
          channel_id: "C_TIME",
          channel_type: "channel",
          is_private: "false",
          ...(wakeId ? { oe_wake_id: wakeId } : {}),
        },
      },
    },
  },
});
const since = new Date(Date.now() - 60_000).toISOString();
const startRows = async () => (await readAudit({ org: "default", action: WAKE_TURN_START_ACTION, since })).filter((r) => r.action === WAKE_TURN_START_ACTION);

await turnStarted({ data: { turnId: "t-none" } }, ctxFor(undefined));
eq((await startRows()).length, 0, "a turn carrying NO wake id writes no anchor row — there is nothing for it to join to");

await turnStarted({ data: { turnId: "t-1" } }, ctxFor("wk-anchor-1"));
const rows = await startRows();
eq(rows.length, 1, "a wake-driven turn writes exactly one anchor row");
const detail = (rows[0].detail ?? {}) as Record<string, unknown>;
eq(detail.wakeId, "wk-anchor-1", "the anchor row joins to the wake the turn woke on");
eq(detail.turnId, "t-1", "the anchor row names the turn");
eq(detail.sessionId, "wrun_time_1", "the anchor row names the session");
ok(typeof detail.turnStartTs === "string" && (detail.turnStartTs as string).endsWith("Z"), "the anchor row carries the turn's own start instant");
eq(rows[0].ts, detail.turnStartTs, "the row's `ts` IS the turn-start instant, so a join on either field gives the same answer");
ok(!JSON.stringify(rows[0]).includes("oe-dom:payments:oe-sup:g1"), "the anchor row carries ids and timestamps only — never the seat's token material");

await turnStarted({ data: { turnId: "t-2" } }, ctxFor("wk-anchor-2"));
eq((await startRows()).length, 2, "a SECOND wake-driven turn on the same session writes a second row");

await turnStarted({ data: {} }, {});
eq((await startRows()).length, 2, "an identity-less context writes NO row and does not throw (the count is unchanged)");

console.log("4. splitWakeLatency:");
const BAND_MS = 7_000;
const environmental = splitWakeLatency({ vendorMs: 0, ingressMs: 1_000, turnStartMs: 11_000, replyMs: 16_000 }, BAND_MS);
eq(environmental.vendorToIngressMs, 1_000, "vendor→ingress is measured from the vendor's own clock");
eq(environmental.ingressToTurnStartMs, 10_000, "ingress→turn-start is the queue: enqueue, pickup and cold start");
eq(environmental.preTurnMs, 11_000, "the pre-turn segment is the two of them together");
eq(environmental.inTurnMs, 5_000, "the in-turn segment starts at the TURN, not at the vendor event");
eq(environmental.totalMs, 16_000, "the total still reports the whole reply-to-reply span a human feels");
eq(environmental.inBand, true, "🔴 the band judges the IN-TURN segment alone — a 16 s reply whose turn took 5 s is IN BAND");
eq(environmental.worst, "ingress-to-turn-start", "the gate points at the queue, which is where the excess actually is");
const ours = splitWakeLatency({ vendorMs: 0, ingressMs: 300, turnStartMs: 900, replyMs: 21_000 }, BAND_MS);
eq(ours.inBand, false, "a turn of 20.1 s against a 7 s band is OVER the band");
eq(ours.worst, "in-turn", "with a quick environment the excess is attributed to the turn — the negative control on the verdict above");
const healthy = splitWakeLatency({ vendorMs: 0, ingressMs: 200, turnStartMs: 700, replyMs: 3_000 }, BAND_MS);
eq(healthy.inBand, true, "a fast turn is in band");
eq(healthy.worst, "none", "with nothing over the band NO segment is named as carrying an excess");
ok(renderWakeSplit("x", healthy, BAND_MS, "slack-ts").includes("no segment is over the band"), "the reported line says plainly that nothing is over the band");
ok(!renderWakeSplit("x", healthy, BAND_MS, "slack-ts").includes("excess carried by"), "a healthy reply's line makes no attribution at all");
eq(splitWakeLatency({ vendorMs: 0, ingressMs: 9_000, turnStartMs: 9_200, replyMs: 12_000 }, BAND_MS).worst, "vendor-to-ingress", "the slower of the two pre-turn segments is the one named");
const noVendorSplit = splitWakeLatency({ ingressMs: 1_000, turnStartMs: 6_000, replyMs: 9_000 }, BAND_MS);
eq(noVendorSplit.vendorToIngressMs, undefined, "no vendor anchor ⇒ that segment is UNMEASURED, never zero");
eq(noVendorSplit.preTurnMs, 5_000, "the pre-turn segment is then the queue alone");
eq(noVendorSplit.totalMs, 8_000, "the total is measured from the earliest anchor present (the ingress)");
const unsplit = splitWakeLatency({ vendorMs: 0, ingressMs: 1_000, replyMs: 16_000 }, BAND_MS);
eq(unsplit.inBand, undefined, "no turn-start anchor ⇒ NO band verdict at all (never a red for a segment we cannot see)");
eq(unsplit.inTurnMs, undefined, "no turn-start anchor ⇒ no in-turn segment");
eq(unsplit.preTurnMs, undefined, "no turn-start anchor ⇒ no pre-turn segment either — there is no boundary to measure either side of");
eq(unsplit.worst, "unsplit", "the split says plainly that it could not be split");

console.log("5. renderWakeSplit:");
const line = renderWakeSplit("leg 1 turn 1", environmental, BAND_MS, "slack-ts");
ok(line.includes("ENVIRONMENTAL"), "the reported line marks the pre-turn segment ENVIRONMENTAL, so a reader cannot take it for a code verdict");
ok(line.includes("IN BAND"), "the reported line states the in-turn verdict");
ok(line.includes("excess carried by: ingress-to-turn-start"), "the reported line names the segment carrying the excess");
ok(!renderWakeSplit("x", environmental, BAND_MS, "slack-ts").includes("LOWER bound"), "a real vendor reading is NOT hedged as a lower bound");
ok(renderWakeSplit("x", environmental, BAND_MS, "receipt").includes("LOWER bound"), "a RECEIPT reading IS hedged — it is taken after the vendor's hop, so the segment is a floor");
ok(renderWakeSplit("x", unsplit, BAND_MS).includes("band applied to NOTHING"), "an unsplit reading says the band judged nothing, rather than printing a verdict it did not earn");

console.log("6. readWakeSplits:");
const ingressRow = (wakeId: string, atMs: number, vendorMs?: number) => ({
  ts: new Date(atMs).toISOString(),
  org: "default",
  platform: "slack",
  workspace: "payments",
  action: "wake.ingress",
  detail: wakeIngressDetail({ wakeId, surfaceKey: "slack/T_TIME/C_TIME", ...(vendorMs === undefined ? {} : { vendor: { ms: vendorMs, source: "slack-ts" as const } }), ingressMs: atMs }),
});
const startRow = (wakeId: string, atMs: number) => ({
  ts: new Date(atMs).toISOString(),
  org: "default",
  platform: "slack",
  workspace: "payments",
  action: WAKE_TURN_START_ACTION,
  detail: { wakeId, turnStartTs: new Date(atMs).toISOString() },
});
const replyRow = (wakeId: string, atMs: number) => ({ ts: new Date(atMs).toISOString(), org: "default", platform: "slack", workspace: "payments", action: "reply.post", detail: { wakeId, chars: 3 } });

const T0 = Date.parse("2026-09-12T12:00:00.000Z");
const wire = [
  ingressRow("A", T0, T0 - 2_000),
  ingressRow("B", T0 + 500, T0 - 500),
  startRow("B", T0 + 1_500),
  replyRow("B", T0 + 4_000),
  startRow("A", T0 + 10_000),
  replyRow("A", T0 + 14_000),
  ingressRow("C", T0 + 600),
  ingressRow("A", T0 + 50, T0 - 2_000),
];
const reader = async () => wire;
const joined = await readWakeSplits(reader, { sinceIso: new Date(T0 - 60_000).toISOString(), platform: "slack", labelPrefix: "leg 1" });
eq(joined.map((r) => r.wakeId), ["A", "B"], "every ANSWERED wake is measured ONCE, in ingress order; the unanswered one is dropped and the re-driven one is not double-counted");
eq(joined.find((r) => r.wakeId === "A")?.split.vendorToIngressMs, 2_000, "a wake with two ingress rows is anchored on the EARLIEST — when the deployment first took the message");
eq(joined.find((r) => r.wakeId === "A")?.split.inTurnMs, 4_000, "wake A is measured against ITS OWN reply, not against the reply that landed first");
eq(joined.find((r) => r.wakeId === "A")?.split.preTurnMs, 12_000, "wake A's pre-turn segment is its vendor hop plus its queue wait");
eq(joined.find((r) => r.wakeId === "B")?.split.inTurnMs, 2_500, "wake B is measured against its own reply too");
ok(joined[0]!.line.includes("leg 1"), "each reading carries the leg label the gate prints");
const windowed = await readWakeSplits(reader, { sinceIso: new Date(T0 - 60_000).toISOString(), untilIso: new Date(T0 + 400).toISOString() });
eq(windowed.map((r) => r.wakeId), ["A"], "the window is keyed on the INGRESS instant, so a later leg's wake is not counted in this leg");
eq(windowed[0]?.split.totalMs, 16_000, "a reply outside the window still measures the wake that arrived inside it");
eq(await readWakeSplits(async () => { throw new Error("audit plane down"); }, { sinceIso: new Date(T0).toISOString() }), [], "an unreadable audit plane resolves to NO readings rather than failing the leg");
ok(summariseWakeSplits([]).includes("no wake was measurable"), "the summary says plainly when nothing was measured");
ok(summariseWakeSplits(joined).includes("2 wake(s) measured"), "the summary counts what it measured");
ok(summariseWakeSplits(joined).includes("ENVIRONMENTAL"), "the summary repeats that the pre-turn segments are never a verdict on the tree");

{
  eq(WAKE_RETRY_ACTION, "surface.wake_retry", "the retry row's action is the stable string the control plane queries");
  const full = wakeRetryDetail({
    wakeId: "w-1",
    deliveryId: "d-1",
    surfaceKey: "slack/T1/C1",
    attempt: 2,
    delayMs: 2_000,
    waitedMs: 2_000,
    outcome: "retrying",
    refusalStatus: 429,
  });
  eq(full, { wakeId: "w-1", deliveryId: "d-1", surfaceKey: "slack/T1/C1", attempt: 2, delayMs: 2_000, waitedMs: 2_000, outcome: "retrying", refusalStatus: 429 }, "the retry row carries the wake id, the attempt, the two durations and the outcome — and nothing else");
  ok(!Object.keys(full).some((k) => k === "message" || k === "text"), "🔴 the retry row carries NO message text — ids, counts and durations only");
  const bare = wakeRetryDetail({ wakeId: "w-2", surfaceKey: "slack/T1/C1", attempt: 1, delayMs: 0, waitedMs: 0, outcome: "exhausted", refusalStatus: 429 });
  ok(!("deliveryId" in bare), "🔴 an absent deliveryId is ABSENT, never present-and-undefined — the same rule the ingress row's vendor reading follows");
  eq(bare.outcome, "exhausted", "the exhausted row says so, so a reader can tell a retried wake from a lost one");

  const native = wakeRetryDetail({ deliveryId: "native-d-1", surfaceKey: "discord/G1/C1", attempt: 1, delayMs: 0, waitedMs: 0, outcome: "retrying", refusalStatus: 429 });
  eq(native, { deliveryId: "native-d-1", surfaceKey: "discord/G1/C1", attempt: 1, delayMs: 0, waitedMs: 0, outcome: "retrying", refusalStatus: 429 }, "🔴 a native retry row carries its real per-dispatch deliveryId and does not fabricate a wakeId");
  ok(!("wakeId" in native), "🔴 native attribution omits wakeId entirely — absence says there is no ingress/turn join");

  const p = WAKE_DISPATCH_RETRY_POLICY;
  ok(p.maxAttempts >= 2, "🔴 the wake dispatch retries at least once — never dropping on the first 429 is the whole acceptance");
  ok(p.totalBudgetMs < (p.maxAttempts - 1) * p.capMs, "🔴 the TOTAL budget, not the attempt count, is what bounds this path's latency");
  ok(p.fallbackMs > 0, "🔴 the fallback is a real wait: eve's queue error names no Retry-After, so every wait on this road uses it");
  ok(p.fallbackMs * (p.maxAttempts - 1) <= p.totalBudgetMs, "the fallback path can spend its attempts without being cut short by the budget");
}

console.log(`wake-timing: ${n} assertions passed`);
