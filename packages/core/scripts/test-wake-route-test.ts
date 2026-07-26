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
process.env.OE_WINDOW_TOPOLOGY = "1";
delete process.env.OE_TEST_WAKE;
delete process.env.OE_CONTROL_READ_TOKENS;
delete process.env.OE_CONTROL_INJECT_TOKENS;

const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureCodec();
__slackStubs.registerSlackFixtureMapper();

const { handleTestWakeInjection, CONTROL_TEST_WAKE_PATH, testWakeEnabled } = await import("../agent/control/test-route.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { unifiedDomainSessionKey, unifiedSupervisorToken, supervisorGrainFor } = await import("../agent/channels/unified-supervisor.js");
const { formatWindowToken } = await import("../agent/channels/window-key.js");
const { readAudit } = await import("../agent/audit/audit.js");

const { registerWakeOriginCodec } = await import("../agent/channels/wake-origin-codec.js");
registerWakeOriginCodec("notion", {
  validate: (o) => typeof o.discussionId === "string" && o.discussionId.length > 0,
  threadRef: (origin) => ({ channelKey: `notion/${origin.pageId ?? origin.discussionId}`, threadKey: origin.discussionId }),
  isThreadScoped: () => true,
  containerId: (origin) => origin.discussionId,
});

const DOMAIN = "e2e-unified";
const ORG = "acme";
const SURFACE = "slack/T1/C1";
const CHANNEL_ID = "C1";
const domains = [
  defineDomain({
    name: DOMAIN,
    channels: [SURFACE],
    ambientSupervisor: true,
    mode: "unified",
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

const INJECT_SECRET = "test-inject-token";
const INJECT_SHA = createHash("sha256").update(INJECT_SECRET, "utf-8").digest("hex");
const READ_SECRET = "test-read-only-token";
const READ_SHA = createHash("sha256").update(READ_SECRET, "utf-8").digest("hex");

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

process.env.OE_CONTROL_INJECT_TOKENS = `eval-injector:${INJECT_SHA}`;
{
  const res = await post(goodBody(), INJECT_SECRET);
  ok(res.status === 404, "OE_TEST_WAKE unset → 404 (seam does not exist) even with tokens + bearer + good body");
  ok(captured.length === 0, "disarmed seam never diverts");
}

process.env.OE_TEST_WAKE = "1";
delete process.env.OE_CONTROL_INJECT_TOKENS;
{
  ok((await post(goodBody(), INJECT_SECRET)).status === 404, "armed but no OE_CONTROL_INJECT_TOKENS → 404");
}

process.env.OE_CONTROL_READ_TOKENS = `eval-harness:${READ_SHA}`;
{
  ok((await post(goodBody(), READ_SECRET)).status === 404, "armed + READ family configured but INJECT family unset → 404 (no fallback to the read family)");
  ok((await post(goodBody(), INJECT_SECRET)).status === 404, "…and the inject VALUE is equally dead while its own family is unconfigured (fail-closed on entries, not on the bearer)");
  ok(captured.length === 0, "no divert while the injection family is unconfigured");
}

process.env.OE_CONTROL_INJECT_TOKENS = `eval-injector:${INJECT_SHA}`;
{
  ok((await post(goodBody())).status === 401, "armed + no bearer → 401");
  ok((await post(goodBody(), "not-the-token")).status === 401, "armed + wrong token → 401");
  ok((await post(goodBody(), READ_SECRET)).status === 401, "🔴 a VALID OE_CONTROL_READ_TOKENS token is REFUSED by the wake route (401) — the read family is not an injection credential");
  ok(captured.length === 0, "a refused read token never reaches the divert seam");
}

{
  const { verifyServiceToken, verifyInjectToken, parseServiceTokenEntries, injectTokenEntries } = await import("../agent/control/auth.js");
  const readEntries = parseServiceTokenEntries(process.env.OE_CONTROL_READ_TOKENS);
  const injEntries = injectTokenEntries();
  ok(verifyServiceToken(INJECT_SECRET, readEntries) === null, "the READ verifier refuses an INJECT-family token value");
  ok(verifyServiceToken(READ_SECRET, readEntries)?.readOnly === true, "…while still admitting its own family as a readOnly principal");
  ok(verifyInjectToken(READ_SECRET, injEntries) === null, "the INJECT verifier refuses a READ-family token value");
  ok(verifyInjectToken(INJECT_SECRET, injEntries)?.subject === "svc:eval-injector", "…and admits its own family as svc:<name>");
  const inj = verifyInjectToken(INJECT_SECRET, injEntries) as unknown as Record<string, unknown>;
  ok(inj.roles === undefined && inj.readOnly === undefined, "an inject identity carries NO roles and NO readOnly flag (not an AdminIdentity)");
  ok(injectTokenEntries({} as NodeJS.ProcessEnv).length === 0, "injectTokenEntries is fail-closed on an env with no OE_CONTROL_INJECT_TOKENS");
}

{
  ok((await post({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, origin: slackOrigin }, INJECT_SECRET)).status === 400, "missing text → 400");
  ok((await post(goodBody({ origin: { platform: "slack" } }), INJECT_SECRET)).status === 400, "invalid origin (no channelId) → 400");
  ok((await post(goodBody({ platform: "notion" }), INJECT_SECRET)).status === 400, "origin.platform != platform → 400");
  ok((await post(goodBody({ surfaceKey: "slack/T1/UNLISTED" }), INJECT_SECRET)).status === 400, "surface not in a windowed domain → 400");
  ok(captured.length === 0, "no divert on any rejected request");
}

{
  const res = await post(goodBody(), INJECT_SECRET);
  ok(res.status === 400, "window enabled but no channel_session row → 400 (seed the window first)");
}

const token = unifiedSupervisorToken(DOMAIN, Date.now());
await getOperationalStore().rotateChannelSession(ORG, unifiedDomainSessionKey(DOMAIN), token, new Date().toISOString());
{
  const res = await post(goodBody(), INJECT_SECRET);
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
  ok(c.message.includes("Cross-surface disclosure:"), "unifiedDisclosure defaults TRUE (matches every real unified dispatch)");
  ok(c.message.includes("this channel's standing session"), "slack containerNoun stays 'channel' (renderWake default)");
}

{
  captured.length = 0;
  await post(goodBody({ unifiedDisclosure: false }), INJECT_SECRET);
  ok(!captured[0].message.includes("Cross-surface disclosure:"), "unifiedDisclosure:false renders without the disclosure sentence");
}

{
  captured.length = 0;
  const notionSurface = "notion/W1/P1";
  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => [defineDomain({ name: DOMAIN, channels: [SURFACE, notionSurface], ambientSupervisor: true, mode: "unified" })],
    loadSilos: () => [], loadRoles: () => [], domainsForSurface: () => [],
  });
  const res = await post({ domain: DOMAIN, platform: "notion", surfaceKey: notionSurface, text: "note for the doc", origin: { platform: "notion", discussionId: "D1" } }, INJECT_SECRET);
  ok(res.status === 200, "notion injection → 200");
  ok(captured[0].message.includes("this doc's standing session"), "notion containerNoun defaults to 'doc' (matches notion-supervisor)");
}

{
  captured.length = 0;
  const res = await post(goodBody({ addressing: "direct-mention", mention: true }), INJECT_SECRET);
  ok(res.status === 200, "direct-mention injection → 200");
  const c = captured[0];
  ok(c.auth.attributes?.oe_addressing === "direct-mention", "direct-mention stamps oe_addressing (enables the addressed-prose bridge)");
  ok(c.message.includes("[direct]"), "direct-mention renders the addressed preamble");
}

{
  captured.length = 0;
  await post(goodBody({ authAttributes: { is_private: "true", user_id: "U999" } }), INJECT_SECRET);
  const c = captured[0];
  ok(c.auth.attributes?.is_private === "true", "caller authAttributes override the surfaceKey-derived defaults");
  ok(c.auth.attributes?.user_id === "U999", "caller authAttributes are merged in");
  ok(c.auth.attributes?.team_id === "T1", "un-overridden derived attrs remain");
}

const norm = (s: string): string =>
  s
    .replace(/sent-at="[^"]*"/g, 'sent-at="TS"')
    .replace(/current-time="[^"]*"/g, 'current-time="TS"')
    .replace(/wake-id="[^"]*"/g, 'wake-id="WID"')
    .replace(/id="test-[^"]*"/g, 'id="MID"');

{
  captured.length = 0;
  const res = await post(
    goodBody({
      messages: [
        { text: "kicking off the release thread", author: "sam" },
        { text: "anyone got the changelog?", author: "priya" },
        { text: "here it is — is this everything we're shipping?", author: "jo" },
      ],
      text: undefined,
    }),
    INJECT_SECRET,
  );
  ok(res.status === 200, "coalesced messages injection → 200");
  const jb = (await res.json()) as { messageCount: number };
  ok(jb.messageCount === 3, "200 body reports messageCount=3");
  const msg = captured[0].message;
  const blocks = msg.match(/<message[ >]/g) ?? [];
  ok(blocks.length === 3, "renders exactly 3 <message> blocks");
  const triggers = msg.match(/<message[^>]*\btrigger="true"/g) ?? [];
  ok(triggers.length === 1, "exactly one message carries trigger=true");
  ok(
    msg.indexOf("kicking off the release thread") < msg.indexOf("anyone got the changelog?") &&
      msg.indexOf("anyone got the changelog?") < msg.indexOf("here it is"),
    "messages render in order (oldest first)",
  );
  ok(
    msg.indexOf('trigger="true"') > msg.indexOf("anyone got the changelog?"),
    "the trigger flag is on the LAST (newest) message, not an earlier one",
  );
  ok(msg.includes("here it is — is this everything we"), "trigger body is the last entry's text (apostrophe XML-escaped)");
}

{
  captured.length = 0;
  const tooMany = Array.from({ length: 11 }, (_, i) => ({ text: `m${i}` }));
  ok((await post(goodBody({ messages: tooMany }), INJECT_SECRET)).status === 400, "messages.length > 10 → 400");
  ok((await post(goodBody({ messages: [] }), INJECT_SECRET)).status === 400, "empty messages array → 400");
  ok((await post(goodBody({ messages: [{ text: "" }] }), INJECT_SECRET)).status === 400, "empty message text → 400");
  ok((await post(goodBody({ messages: [{ text: "x".repeat(4001) }] }), INJECT_SECRET)).status === 400, "message text > 4000 chars → 400");
  ok(captured.length === 0, "no divert on any rejected coalesced request");
}

{
  captured.length = 0;
  await post(goodBody({ text: "one line only", author: "sam" }), INJECT_SECRET);
  const single = norm(captured[0].message);
  captured.length = 0;
  await post(goodBody({ messages: [{ text: "one line only", author: "sam" }], text: undefined }), INJECT_SECRET);
  const oneEntry = norm(captured[0].message);
  ok(single === oneEntry, "single-text render == single-entry coalesced render (byte-identical, single path untouched)");
  ok(single.includes("[channel-watch]"), "the frozen single-text render is still the judged channel-watch envelope");
}

const SOLO_DOMAIN = "e2e-solo";
const SOLO_SURFACE = "slack/T2/C2";
const soloOrigin = { platform: "slack", channelId: "C2" } as const;
const soloDomains = [
  defineDomain({ name: SOLO_DOMAIN, channels: [SOLO_SURFACE], ambientSupervisor: true, mode: "solo" }),
];
function useDomains(ds: ReturnType<typeof defineDomain>[]): void {
  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => ds, loadSilos: () => [], loadRoles: () => [], domainsForSurface: () => [],
  });
}
function soloBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { domain: SOLO_DOMAIN, platform: "slack", surfaceKey: SOLO_SURFACE, text: "solo window, anything blocked?", origin: soloOrigin, ...over };
}

{
  process.env.OE_WINDOW_TOPOLOGY = "1";
  useDomains(soloDomains);
  const soloGrain = supervisorGrainFor(SOLO_SURFACE, soloDomains);
  ok(soloGrain.registryKey === unifiedDomainSessionKey(SOLO_SURFACE), "solo grain keys the registry row by the surfaceKey windowId, not the domain");
  ok(soloGrain.registryKey !== unifiedDomainSessionKey(SOLO_DOMAIN), "solo registryKey is DISTINCT from the domain-keyed row (the row a hardcoded domain key would read)");
  useDomains(domains);
  ok(supervisorGrainFor(SURFACE, domains).registryKey === unifiedDomainSessionKey(DOMAIN), "cross-surface grain registryKey === unifiedDomainSessionKey(domain) — byte-identical to the pre-fix hardcoded key");
}

{
  captured.length = 0;
  process.env.OE_WINDOW_TOPOLOGY = "1";
  useDomains(soloDomains);
  await getOperationalStore().rotateChannelSession(ORG, unifiedDomainSessionKey(SOLO_DOMAIN), unifiedSupervisorToken(SOLO_DOMAIN, Date.now()), new Date().toISOString());
  ok((await post(soloBody(), INJECT_SECRET)).status === 400, "solo domain with ONLY a domain-keyed row → 400 (the route reads the WINDOW's row, not the domain's)");
  ok(captured.length === 0, "no divert while the solo window's own row is absent");

  const soloToken = formatWindowToken({ domain: SOLO_DOMAIN, windowId: SOLO_SURFACE, generation: Date.now() });
  await getOperationalStore().rotateChannelSession(ORG, unifiedDomainSessionKey(SOLO_SURFACE), soloToken, new Date().toISOString());
  const res = await post(soloBody(), INJECT_SECRET);
  ok(res.status === 200, "solo window (mode:solo + code gate) is INJECTABLE → 200");
  const jb = (await res.json()) as { token: string };
  ok(jb.token === soloToken, "solo injection dispatches the SOLO window's live token (windowId === surfaceKey)");
  ok(captured.length === 1 && (captured[0].target as { token?: string }).token === soloToken, "solo divert carries the solo window token");
}

{
  captured.length = 0;
  process.env.OE_WINDOW_TOPOLOGY = "0";
  useDomains(soloDomains);
  ok((await post(soloBody(), INJECT_SECRET)).status === 400, "mode:solo but WINDOW_TOPOLOGY_ENABLED off → 400 (gate-off makes the mode inert)");
  ok(captured.length === 0, "no divert on any window-gate rejection");
  process.env.OE_WINDOW_TOPOLOGY = "1";
}

{
  captured.length = 0;
  useDomains(domains);
  ok((await post(goodBody({ domain: "some-other-domain" }), INJECT_SECRET)).status === 400, "claimed domain != the surfaceKey's resolved domain → 400 (fail-closed)");
  ok(captured.length === 0, "no divert on a domain mismatch");
}

{
  const audit = await readAudit({ org: ORG });
  const rows = audit.filter((e) => e.action === "control.service_call" && (e.detail as { view?: string })?.view === "test_wake");
  ok(rows.length >= 3, "each authenticated injection is self-audited as control.service_call / view=test_wake");
  ok(rows.some((e) => (e.detail as { addressing?: string })?.addressing === "direct-mention"), "audit detail records the injected addressing");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ test-wake route: ${passed} assertions passed (triple fail-closed gate + INJECT-vs-READ credential separation + validation + render+divert + self-audit)\n`);
