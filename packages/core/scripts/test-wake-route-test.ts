import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-test-wake-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
process.env.OE_UNIFIED_SUPERVISOR = "1";
process.env.OE_CROSS_SURFACE_WINDOW = "1";
delete process.env.OE_TEST_WAKE;
delete process.env.OE_CONTROL_READ_TOKENS;

const { handleTestWakeInjection, CONTROL_TEST_WAKE_PATH, testWakeEnabled } = await import("../agent/control/test-route.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { unifiedDomainSessionKey, unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { readAudit } = await import("../agent/audit/audit.js");

const DOMAIN = "e2e-unified";
const ORG = "acme";
const SURFACE = "slack/T1/C1";
const CHANNEL_ID = "C1";
const domains = [
  defineDomain({
    name: DOMAIN,
    channels: [SURFACE],
    ambientSupervisor: true,
    unifiedSupervisor: true,
    crossSurfaceWindow: true,
  }),
];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  loadRoles: () => [],
  domainsForSurface: () => [],
});

const SECRET = "test-wake-test-token";
const SHA = createHash("sha256").update(SECRET, "utf-8").digest("hex");

const slackOrigin = { platform: "slack", channelId: CHANNEL_ID } as const;
function goodBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, text: "hello team, is anything blocked?", origin: slackOrigin, ...over };
}

interface Captured { message: string; target: Record<string, unknown>; auth: { attributes?: Record<string, unknown> } }
const captured: Captured[] = [];
const captureReceive: any = async (_channel: unknown, input: Captured) => {
  captured.push(input);
  return { id: "sess-test-xyz" };
};

function post(body: unknown, token?: string, receive = captureReceive): Promise<Response> {
  return handleTestWakeInjection(
    new Request(`https://oe.example${CONTROL_TEST_WAKE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
    receive,
  );
}

{
  ok(testWakeEnabled({ OE_TEST_WAKE: "1" } as NodeJS.ProcessEnv), "testWakeEnabled: '1' → true");
  ok(testWakeEnabled({ OE_TEST_WAKE: "true" } as NodeJS.ProcessEnv), "testWakeEnabled: 'true' → true");
  ok(!testWakeEnabled({} as NodeJS.ProcessEnv), "testWakeEnabled: unset → false");
  ok(!testWakeEnabled({ OE_TEST_WAKE: "0" } as NodeJS.ProcessEnv), "testWakeEnabled: '0' → false");
}

process.env.OE_CONTROL_READ_TOKENS = `eval-harness:${SHA}`;
{
  const res = await post(goodBody(), SECRET);
  ok(res.status === 404, "OE_TEST_WAKE unset → 404 (seam does not exist) even with tokens + bearer + good body");
  ok(captured.length === 0, "disarmed seam never diverts");
}

process.env.OE_TEST_WAKE = "1";
delete process.env.OE_CONTROL_READ_TOKENS;
{
  ok((await post(goodBody(), SECRET)).status === 404, "armed but no OE_CONTROL_READ_TOKENS → 404");
}

process.env.OE_CONTROL_READ_TOKENS = `eval-harness:${SHA}`;
{
  ok((await post(goodBody())).status === 401, "armed + no bearer → 401");
  ok((await post(goodBody(), "not-the-token")).status === 401, "armed + wrong token → 401");
}

{
  ok((await post({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, origin: slackOrigin }, SECRET)).status === 400, "missing text → 400");
  ok((await post(goodBody({ origin: { platform: "slack" } }), SECRET)).status === 400, "invalid origin (no channelId) → 400");
  ok((await post(goodBody({ platform: "notion" }), SECRET)).status === 400, "origin.platform != platform → 400");
  ok((await post(goodBody({ surfaceKey: "slack/T1/UNLISTED" }), SECRET)).status === 400, "surface not in a crossSurfaceWindow domain → 400");
  ok(captured.length === 0, "no divert on any rejected request");
}

{
  const res = await post(goodBody(), SECRET);
  ok(res.status === 400, "crossSurfaceWindow OK but no channel_session row → 400 (seed the window first)");
}

const token = unifiedSupervisorToken(DOMAIN, Date.now());
await getOperationalStore().rotateChannelSession(ORG, unifiedDomainSessionKey(DOMAIN), token, new Date().toISOString());
{
  const res = await post(goodBody(), SECRET);
  ok(res.status === 200, "armed + bearer + valid body + seeded window → 200");
  const jb = (await res.json()) as { ok: boolean; wakeId: string; token: string; surfaceKey: string; addressing: string };
  ok(jb.ok === true && typeof jb.wakeId === "string" && jb.wakeId.length > 0, "200 body carries a minted wakeId");
  ok(jb.token === token, "200 body echoes the LIVE session token (from the channel_session row)");
  ok(jb.addressing === "channel-watch", "default addressing is channel-watch (ambient)");

  ok(captured.length === 1, "exactly one divert into the unified window");
  const c = captured[0];
  ok((c.target as { token?: string }).token === token, "divert target carries the live token");
  ok((c.target as { surfaceKey?: string }).surfaceKey === SURFACE, "divert target carries the surfaceKey");
  ok(JSON.stringify((c.target as { origin?: unknown }).origin) === JSON.stringify(slackOrigin), "divert target carries the REAL origin");
  ok((c.target as { wakeId?: string }).wakeId === jb.wakeId, "divert wakeId matches the response wakeId");
  ok(c.auth.attributes?.oe_platform === "slack", "auth stamped oe_platform=slack (channelPlatform's unified hop reads it)");
  ok(c.auth.attributes?.oe_wake_id === jb.wakeId, "auth stamped oe_wake_id = the minted wake id");
  ok(c.auth.attributes?.team_id === "T1" && c.auth.attributes?.channel_id === "C1", "auth carries partition attrs derived from surfaceKey");
  ok(c.message.includes("[channel-watch]"), "rendered message is the judged channel-watch envelope (byte-identical to a real ambient wake)");
  ok(c.message.includes("hello team, is anything blocked?"), "rendered message contains the trigger body");
}

{
  captured.length = 0;
  const res = await post(goodBody({ addressing: "direct-mention", mention: true }), SECRET);
  ok(res.status === 200, "direct-mention injection → 200");
  const c = captured[0];
  ok(c.auth.attributes?.oe_addressing === "direct-mention", "direct-mention stamps oe_addressing (enables the addressed-prose bridge)");
  ok(c.message.includes("[direct]"), "direct-mention renders the addressed preamble");
}

{
  captured.length = 0;
  await post(goodBody({ authAttributes: { is_private: "true", user_id: "U999" } }), SECRET);
  const c = captured[0];
  ok(c.auth.attributes?.is_private === "true", "caller authAttributes override the surfaceKey-derived defaults");
  ok(c.auth.attributes?.user_id === "U999", "caller authAttributes are merged in");
  ok(c.auth.attributes?.team_id === "T1", "un-overridden derived attrs remain");
}

{
  const audit = await readAudit({ org: ORG });
  const rows = audit.filter((e) => e.action === "control.service_call" && (e.detail as { view?: string })?.view === "test_wake");
  ok(rows.length >= 3, "each authenticated injection is self-audited as control.service_call / view=test_wake");
  ok(rows.some((e) => (e.detail as { addressing?: string })?.addressing === "direct-mention"), "audit detail records the injected addressing");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ test-wake route: ${passed} assertions passed (triple fail-closed gate + validation + render+divert + self-audit)\n`);
