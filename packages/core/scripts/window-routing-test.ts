import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-window-routing-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { classifyWindowRouting, WINDOW_ROUTING_DEGRADED_ACTION } from "../agent/access/window-routing.js";
import { readAudit } from "../agent/audit/audit.js";
import routingHook from "../agent/hooks/window-routing.js";
import { registerSlackFixtureMapper, registerSlackFixtureCodec } from "./_slack-test-stubs.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
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

const WINDOWED_KEY = "slack/T_ROUTE/C_WINDOWED";
const PLAIN_KEY = "slack/T_ROUTE/C_PLAIN";
const windowedDomain = defineDomain({ name: "payments", channels: [WINDOWED_KEY], ambientSupervisor: true, mode: "unified" });
const plainDomain = defineDomain({ name: "sundries", channels: [PLAIN_KEY] });
const domains = [windowedDomain, plainDomain];

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === "C_WINDOWED" ? ["payments"] : surface === "C_PLAIN" ? ["sundries"] : []),
});

console.log("1. classifyWindowRouting:");
overrideSettingsForTest({ window: { topology: true } });
eq(classifyWindowRouting("native", WINDOWED_KEY, domains), "native-degraded", "ARMED + a windowing domain + a native seat = the invariant violation");
eq(classifyWindowRouting("native", PLAIN_KEY, domains), "native-by-design", "an explicit domain that is not an ambient supervisor cannot window — native is correct there");
eq(classifyWindowRouting("native", "slack/T_ROUTE/C_UNMAPPED", domains), "native-by-design", "a channel with NO domain has no window to divert into (the OPE-119 shape) — not a routing bug");
for (const grain of ["standing", "task", "thread"] as const) {
  eq(classifyWindowRouting(grain, WINDOWED_KEY, domains), "windowed", `a ${grain} seat is on the intended path by construction`);
}
overrideSettingsForTest({ window: { topology: false } });
eq(classifyWindowRouting("native", WINDOWED_KEY, domains), "native-by-design", "gate OFF (the CI-pinned OSS default) ⇒ EVERY seat is native and NOTHING is degraded — the detector must be silent on a fresh clone");

console.log("2. hooks/window-routing turn.started:");
const turnStarted = (routingHook as { events: { "turn.started": (e: unknown, ctx: unknown) => Promise<void> } }).events["turn.started"];

const nativeCtx = (channel: string) => ({
  channel: { kind: "slack", continuationToken: "cse_native_route_1" },
  session: { auth: { current: { attributes: { team_id: "T_ROUTE", channel_id: channel, channel_type: "channel", is_private: "false", oe_wake_id: "wk-route-1" } } } },
});

const since = new Date(Date.now() - 60_000).toISOString();
const rowsFor = async () => (await readAudit({ org: "default", action: WINDOW_ROUTING_DEGRADED_ACTION, since })).filter((r) => r.action === WINDOW_ROUTING_DEGRADED_ACTION);

overrideSettingsForTest({ window: { topology: false } });
await turnStarted(null, nativeCtx("C_WINDOWED"));
eq((await rowsFor()).length, 0, "gate OFF: a native wake on a windowing domain writes NO row (that is the default posture, not a fault)");

overrideSettingsForTest({ window: { topology: true } });
await turnStarted(null, nativeCtx("C_PLAIN"));
eq((await rowsFor()).length, 0, "armed: a native wake on a NON-windowing domain writes no row");

await turnStarted(null, nativeCtx("C_WINDOWED"));
const rows = await rowsFor();
eq(rows.length, 1, "armed: a native wake on a WINDOWING domain writes exactly one row");
const detail = (rows[0].detail ?? {}) as Record<string, unknown>;
eq(detail.grain, "native", "row names the grain the wake actually landed on");
eq(detail.domainKey, WINDOWED_KEY, "row names the domain-grain key the invariant was tested against");
eq(detail.wakeId, "wk-route-1", "row joins to the wake");
ok(typeof detail.recall === "string", "row states the practical consequence — which recall route the degraded seat is left with");
ok(!JSON.stringify(rows[0]).includes("cse_native_route_1"), "row carries names/ids only — never the session's token material");

await turnStarted(null, nativeCtx("C_WINDOWED"));
eq((await rowsFor()).length, 2, "a second degraded wake writes a SECOND row (the metric is how many wakes degraded)");

await turnStarted(null, {});
ok(true, "an identity-less context is absorbed (observation must never fail a wake)");

console.log(`window-routing: ${n} assertions passed`);
