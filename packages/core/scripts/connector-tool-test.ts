import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `oe-connector-tool-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
const ORG = "default";

const {
  resolveConnectorOptions,
  optionLabel,
  BROKER_INTAKE_CAPS,
  hostWriteBrokerAvailable,
  hostWriteHomeAvailable,
} = await import("../agent/connections/connector-offer.js");
type CredentialHome = import("../agent/credentials/home.js").CredentialHome;
const fakeHome = (name: string, hw: boolean): CredentialHome => ({ name, hostWriteAvailable: () => hw, store: async () => {} });
const { executorCredentialRef } = await import("../agent/credentials/ref.js");
const { buildConnectCard, handleConnectClick, OE_CONNECT_ACTION_PREFIX } = await import("../agent/connections/connector-card.js");
const { AUTH_URL_TTL_MS } = await import("../agent/connections/connector-auth.js");
const { rawVaultSubject } = await import("../agent/identity/oauth-vault-share.js");
const { readAudit } = await import("../agent/audit/audit.js");
type Provider = import("../agent/access/providers.js").Provider;
const { vercelConnectorHome, executorHome } = await import("../agent/access/providers.js");
type ConnectorOption = import("../agent/connections/connector-offer.js").ConnectorOption;
type Domain = import("../agent/memory/domain.js").Domain;

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const NOTION: Provider = {
  name: "notion",
  connection: "notion",
  allows: ["api-key", "service-oauth", "user-oauth"],
  credentials: [
    { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY", broker: "env" },
    { id: "team-oauth", type: "service-oauth", home: vercelConnectorHome("notion.so/open-everywhere"), dashboardUrl: "https://vercel.com/team-x/~/connect/scl_TEST" },
    { id: "user-oauth", type: "user-oauth", home: vercelConnectorHome("notion.so/open-everywhere") },
  ],
};

const kinds = (opts: readonly ConnectorOption[]): string[] => opts.map((o) => `${optionLabel(o)}:${o.route.kind}`);
const R = (over: Partial<Parameters<typeof resolveConnectorOptions>[0]>) =>
  resolveConnectorOptions({ provider: NOTION, platform: "slack", mode: "channel", isAdmin: true, hostWriteBroker: true, ...over });

console.log("1. resolver matrix:");
{
  eq(kinds(R({ mode: "dm", isAdmin: true })), ["Connect my account:url", "Connect org account:url", "Set API key:modal"], "DM + admin + slack + db ⇒ all three, api-key via modal");
  eq(kinds(R({ mode: "channel", isAdmin: true })), ["Connect org account:url", "Set API key:modal"], "channel + admin ⇒ personal-oauth OMITTED (DM-only), org-level offered");
  eq(kinds(R({ mode: "channel", isAdmin: false })), [], "channel + member ⇒ nothing (org-level admin-only, personal DM-only)");
  eq(kinds(R({ mode: "dm", isAdmin: false })), ["Connect my account:url"], "DM + member ⇒ personal-oauth self-serve; org-level still OMITTED");
  eq(kinds(R({ platform: "discord", isAdmin: true })), ["Connect org account:url", "Set API key:text-degrade"], "discord ⇒ no secret modal ⇒ api-key text-degrades");
  eq(kinds(R({ platform: "notion", isAdmin: true })), ["Connect org account:url", "Set API key:text-degrade"], "notion surface ⇒ api-key text-degrades (no modal there)");
  eq(kinds(R({ hostWriteBroker: false })), ["Connect org account:url", "Set API key:unavailable"], "no host-write broker registered ⇒ api-key UNAVAILABLE (nothing can store a pasted key)");

  ok(R({ mode: "channel", isAdmin: false, platform: "discord" }).length === 0, "member on discord ⇒ still nothing offerable");

  const NARROW: Provider = { name: "narrow", connection: "n", allows: ["user-oauth"], credentials: NOTION.credentials };
  eq(kinds(resolveConnectorOptions({ provider: NARROW, platform: "slack", mode: "dm", isAdmin: true, hostWriteBroker: true })), ["Connect my account:url"], "allowlist ⇒ only user-oauth offered though api-key/service-oauth creds exist");

  const OAUTHLESS: Provider = { name: "k", connection: "k", allows: ["api-key"], credentials: [{ id: "key", type: "api-key", secretRef: "K_KEY", broker: "env" }] };
  eq(kinds(resolveConnectorOptions({ provider: OAUTHLESS, platform: "slack", mode: "channel", isAdmin: true, hostWriteBroker: true })), ["Set API key:modal"], "api-key-only provider ⇒ just the api-key option");

  const PLUMBING_FIRST: Provider = {
    name: "notion",
    connection: "notion",
    allows: ["api-key"],
    credentials: [
      { id: "channel-key", type: "api-key", secretRef: "NOTION_CHANNEL_API_KEY", broker: "env", intake: false },
      { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY", broker: "env" },
    ],
  };
  const plumbOpts = resolveConnectorOptions({ provider: PLUMBING_FIRST, platform: "slack", mode: "channel", isAdmin: true, hostWriteBroker: true });
  eq(kinds(plumbOpts), ["Set API key:modal"], "two api-key creds (plumbing first) ⇒ still exactly one api-key option");
  ok(plumbOpts[0].credentialId === "team-key" && plumbOpts[0].secretRef === "NOTION_API_KEY", "the offered api-key option binds the INTAKE-ABLE team-key, never the intake:false plumbing channel-key");

  const dmOpts = R({ mode: "dm", isAdmin: true });
  const api = dmOpts.find((o) => o.credentialType === "api-key")!;
  const svc = dmOpts.find((o) => o.credentialType === "service-oauth")!;
  ok(api.secretRef === "NOTION_API_KEY" && api.route.kind === "modal", "api-key option carries its secretRef (egress resolves the SAME ref)");
  ok(svc.vercelConnector === "notion.so/open-everywhere", "service-oauth option carries its vercelConnector");

  ok(BROKER_INTAKE_CAPS.db.hostWrite === true && BROKER_INTAKE_CAPS.env.hostWrite === false, "broker declarations: only db can host-write today");

  ok(hostWriteBrokerAvailable(["env", "some-vault"]) === false, "hostWriteBrokerAvailable: env + a non-hostWrite broker ⇒ no host-write broker");
  ok(hostWriteBrokerAvailable(["env", "db"]) === true, "hostWriteBrokerAvailable: db registered ⇒ host-write available");
  ok(hostWriteBrokerAvailable([]) === false, "hostWriteBrokerAvailable: nothing registered ⇒ false (fail closed)");

  ok(hostWriteHomeAvailable([fakeHome("db", false), fakeHome("env", false)]) === false, "hostWriteHomeAvailable: only non-host-write homes ⇒ no host-write home");
  ok(hostWriteHomeAvailable([fakeHome("executor", true)]) === true, "hostWriteHomeAvailable: an executor home reporting host-write ⇒ available");
  ok(hostWriteHomeAvailable([fakeHome("db", true), fakeHome("env", false)]) === true, "hostWriteHomeAvailable: the db home reporting host-write ⇒ available");
  ok(hostWriteHomeAvailable([]) === false, "hostWriteHomeAvailable: no homes ⇒ false (fail closed)");

  eq(kinds(R({ mode: "channel", isAdmin: true, hostWriteBroker: true })), ["Connect org account:url", "Set API key:modal"], "executor-armed (hostWriteBroker true via executor) ⇒ api-key offered as a modal, no db broker needed");
}

console.log("2. card build:");
{
  const opts = R({ mode: "dm", isAdmin: true });
  const { blocks, text } = buildConnectCard("notion", opts, ORG);
  const arr = blocks as Array<Record<string, unknown>>;
  ok(arr[0].type === "section", "card[0] is the header section");
  const actions = arr.find((b) => b.type === "actions") as { elements: Array<Record<string, unknown>> } | undefined;
  ok(!!actions && actions.elements.length === 3, "3 actionable options ⇒ 3 buttons");
  const ids = actions!.elements.map((e) => e.action_id);
  eq(ids, [`${OE_CONNECT_ACTION_PREFIX}notion:user-oauth`, `${OE_CONNECT_ACTION_PREFIX}notion:service-oauth`, `${OE_CONNECT_ACTION_PREFIX}notion:api-key`], "button action_ids encode provider + credential type");
  ok(actions!.elements.every((e) => e.value === ORG), "each button carries the org as value (click handler resolves it)");
  ok(actions!.elements[0].style === "primary", "the personal-oauth button is the primary");
  ok(!JSON.stringify(blocks).toLowerCase().includes("http"), "NO url anywhere in the card JSON (URLs mint at the click)");
  ok(typeof text === "string" && text.length > 0, "card carries a text fallback");

  const dOpts = R({ platform: "discord", isAdmin: true });
  const dCard = buildConnectCard("notion", dOpts, ORG).blocks as Array<Record<string, unknown>>;
  const dActions = dCard.find((b) => b.type === "actions") as { elements: unknown[] } | undefined;
  ok(!!dActions && dActions.elements.length === 1, "discord ⇒ only the service-oauth button is actionable");
  const context = dCard.find((b) => b.type === "context") as { elements: Array<{ text: string }> } | undefined;
  ok(!!context && /Set API key/.test(context.elements[0].text), "the api-key text-degrade is a context line, not a dead button");
}

console.log("3. click handlers:");

const DOMAINS: Domain[] = [{ name: "org", match: "org", admins: ["slack/T1/U_ADMIN"] }];
const FAKE_URL = "https://connect.example/CAP-TOKEN-DO-NOT-LEAK";

function recorder() {
  const calls: { method: string; body: string }[] = [];
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true } as Record<string, unknown>;
  };
  return { post, calls, methods: () => calls.map((c) => c.method) };
}

function starter() {
  const calls: { vc: string; subject: unknown; expiresInMs?: number }[] = [];
  const startAuth = async (vc: string, params: { subject: unknown }, options: { expiresInMs?: number }) => {
    calls.push({ vc, subject: params.subject, expiresInMs: options.expiresInMs });
    return { url: FAKE_URL };
  };
  return { startAuth, calls };
}

const click = (type: string, user: string, channelId: string) => ({
  type: "block_actions",
  user: { id: user },
  team: { id: "T1" },
  channel: { id: channelId },
  actions: [{ action_id: `${OE_CONNECT_ACTION_PREFIX}notion:${type}`, value: ORG }],
});

const deps = (over: Record<string, unknown> = {}) => ({
  loadProviders: () => [NOTION],
  loadDomains: () => DOMAINS,
  ...over,
});

ok((await handleConnectClick({ type: "block_actions", actions: [{ action_id: "oe_setkey:x" }] }, deps())) === false, "a non-oe_connect click is NOT ours (returns false to forward)");

{
  const rec = recorder();
  const st = starter();
  ok((await handleConnectClick(click("user-oauth", "U_ANYONE", "D999"), deps({ post: rec.post, startAuth: st.startAuth }))) === true, "personal-oauth DM click is ours");
  eq(st.calls.length, 1, "personal-oauth ⇒ exactly one mint");
  eq(st.calls[0].subject, { type: "user", id: rawVaultSubject(ORG, "slack", "T1", "U_ANYONE") }, "personal-oauth mints a {type:user} subject = the CLICKER's QUALIFIED vault subject (the same string the later token read composes)");
  ok((st.calls[0].subject as { id?: string }).id !== "U_ANYONE", "🔴 NOT the bare Slack member id — that spelling let two workspaces' humans share one personal-token row");
  eq(st.calls[0].expiresInMs, AUTH_URL_TTL_MS, "the URL is minted with the short capability TTL");
  ok(rec.methods().includes("chat.postEphemeral"), "the URL is delivered EPHEMERALLY (clicker-only)");
  ok(rec.calls.some((c) => c.body.includes(encodeURIComponent(FAKE_URL)) || c.body.includes(FAKE_URL)), "the ephemeral post carries the URL");
}

{
  const rec = recorder();
  const st = starter();
  ok((await handleConnectClick(click("user-oauth", "U_ANYONE", "C123"), deps({ post: rec.post, startAuth: st.startAuth }))) === true, "personal-oauth channel click is still ours (handled)");
  eq(st.calls.length, 0, "personal-oauth in a channel mints NOTHING (DM-only)");
  ok(rec.methods().includes("chat.postEphemeral"), "a refusal notice is posted");
}

{
  const rec = recorder();
  const st = starter();
  ok((await handleConnectClick(click("service-oauth", "U_ADMIN", "C123"), deps({ post: rec.post, startAuth: st.startAuth }))) === true, "service-oauth admin click handled");
  eq(st.calls.length, 0, "service-oauth NEVER calls startAuthorization (app subjects rejected by the hosted flow)");
  ok(rec.methods().includes("chat.postEphemeral"), "the dashboard link is delivered EPHEMERALLY");
  ok(
    rec.calls.some((c) => decodeURIComponent(c.body.replace(/\+/g, " ")).includes("https://vercel.com/team-x/~/connect/scl_TEST")),
    "the ephemeral post carries the configured dashboard URL",
  );
  const dashRows = (await readAudit({ org: ORG })).filter((r) => r.action === "connector.dashboard_link_issued");
  ok(dashRows.length >= 1 && JSON.stringify(dashRows[0].detail).includes('"configured":true'), "audit: connector.dashboard_link_issued with configured:true");

  const rec2 = recorder();
  const st2 = starter();
  await handleConnectClick(click("service-oauth", "U_MEMBER", "C123"), deps({ post: rec2.post, startAuth: st2.startAuth }));
  eq(st2.calls.length, 0, "service-oauth by a NON-admin mints NOTHING (standing re-verified host-side, card not trusted)");
  ok(rec2.methods().includes("chat.postEphemeral"), "a non-admin gets a refusal notice");
}

{
  const intakeCalls: Array<Record<string, unknown>> = [];
  const requestIntake = async (input: Record<string, unknown>) => {
    intakeCalls.push(input);
    return { id: "intake-x" };
  };
  const rec = recorder();
  ok((await handleConnectClick(click("api-key", "U_ADMIN", "C123"), deps({ post: rec.post, requestIntake }))) === true, "api-key admin click handled");
  eq(intakeCalls.length, 1, "admin api-key ⇒ the intake flow is invoked");
  ok(intakeCalls[0].ref === "db:notion:team-key" && intakeCalls[0].requestedBy === "U_ADMIN" && intakeCalls[0].provider === "notion", "the intake is asked for the credential's reversible db ref (db:notion:team-key), on behalf of the clicker");

  const intakeCalls2: Array<Record<string, unknown>> = [];
  const requestIntake2 = async (input: Record<string, unknown>) => {
    intakeCalls2.push(input);
    return { id: "y" };
  };
  const rec2 = recorder();
  await handleConnectClick(click("api-key", "U_MEMBER", "C123"), deps({ post: rec2.post, requestIntake: requestIntake2 }));
  eq(intakeCalls2.length, 0, "api-key by a NON-admin does NOT open the intake (standing re-verified)");

  const NOTION_WITH_PLUMBING: Provider = {
    name: "notion",
    connection: "notion",
    allows: ["api-key"],
    credentials: [
      { id: "channel-key", type: "api-key", secretRef: "NOTION_CHANNEL_API_KEY", broker: "env", intake: false },
      { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY", broker: "env" },
    ],
  };
  const intakeCalls3: Array<Record<string, unknown>> = [];
  const requestIntake3 = async (input: Record<string, unknown>) => {
    intakeCalls3.push(input);
    return { id: "z" };
  };
  const rec3 = recorder();
  await handleConnectClick(
    click("api-key", "U_ADMIN", "C123"),
    deps({ loadProviders: () => [NOTION_WITH_PLUMBING], post: rec3.post, requestIntake: requestIntake3 }),
  );
  eq(intakeCalls3.length, 1, "admin api-key click against the plumbing-carrying provider ⇒ intake invoked");
  ok(intakeCalls3[0].ref === "db:notion:team-key", "the forged api-key click resolves the intake-able team-key (db:notion:team-key), NEVER the intake:false channel-key plumbing");

  const NOTION_EXECUTOR: Provider = {
    name: "notion",
    connection: "notion",
    allows: ["api-key"],
    credentials: [{ id: "team-key", type: "api-key", home: executorHome({ integration: "notion-mcp", owner: "org", connection: "oe-notion-team-key" }) }],
  };
  const intakeCalls4: Array<Record<string, unknown>> = [];
  const requestIntake4 = async (input: Record<string, unknown>) => (intakeCalls4.push(input), { id: "e" });
  await handleConnectClick(click("api-key", "U_ADMIN", "C123"), deps({ loadProviders: () => [NOTION_EXECUTOR], post: recorder().post, requestIntake: requestIntake4 }));
  eq(intakeCalls4.length, 1, "admin api-key click against an executor-homed provider ⇒ intake invoked");
  ok(intakeCalls4[0].ref === executorCredentialRef("notion-mcp", "org", "oe-notion-team-key"), "the executor-homed api-key click stamps an executor: ref (the connection address), NOT a db ref");
}

{
  const logs: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  const rec = recorder();
  const st = starter();
  try {
    await handleConnectClick(click("user-oauth", "U_LEAKTEST", "D777"), deps({ post: rec.post, startAuth: st.startAuth }));
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
  ok(!logs.some((l) => l.includes(FAKE_URL)), "leak-proof: the capability URL appears in NO console output");
  const auditRows = await readAudit({ org: ORG });
  ok(auditRows.some((r) => r.action === "connector.oauth_url_issued"), "audit: a connector.oauth_url_issued row exists");
  ok(!JSON.stringify(auditRows).includes(FAKE_URL), "leak-proof: the capability URL appears in NO audit row");
  const issued = auditRows.filter((r) => r.action === "connector.oauth_url_issued");
  ok(issued.some((r) => JSON.stringify(r.detail).includes('"subject":"user"')), "audit records the subject TYPE (user), not the URL");
}

console.log(`\nconnector-tool-test: ${n} checks passed`);
