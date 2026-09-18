import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

const dir = join(tmpdir(), `oe-connector-tool-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
const ORG = "default";

const {
  resolveConnectorOptions,
  optionLabel,
  unqualifiedAppRowMintHome,
  BROKER_INTAKE_CAPS,
  hostWriteBrokerAvailable,
  hostWriteHomeAvailable,
} = await import("../agent/connections/connector-offer.js");
type CredentialHome = import("../agent/credentials/home.js").CredentialHome;
const fakeHome = (name: string, hw: boolean): CredentialHome => ({ name, hostWriteAvailable: () => hw, store: async () => {} });
const { buildConnectCard, handleConnectClick, renderNonSlackConnect, OE_CONNECT_ACTION_PREFIX } = await import("../agent/connections/connector-card.js");
const { AUTH_URL_TTL_MS } = await import("../agent/connections/connector-auth.js");
const { rawVaultSubject } = await import("../agent/identity/oauth-vault-share.js");
const { readAudit } = await import("../agent/audit/audit.js");
type ConnectorCredentials = import("../agent/access/connector-credentials.js").ConnectorCredentials;
const { vercelConnectorHome } = await import("../agent/access/connector-credentials.js");
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

const NOTION: ConnectorCredentials = {
  connector: "notion",
  allows: ["api-key", "service-oauth", "user-oauth"],
  credentials: [
    { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY", broker: "env" },
    { id: "team-oauth", type: "service-oauth", home: vercelConnectorHome("notion.so/open-everywhere"), dashboardUrl: "https://vercel.com/team-x/~/connect/scl_TEST" },
    { id: "user-oauth", type: "user-oauth", home: vercelConnectorHome("notion.so/open-everywhere") },
  ],
};

const NOTION_ORG_MINT: ConnectorCredentials = {
  connector: "notion",
  allows: ["api-key", "service-oauth", "user-oauth"],
  credentials: [
    { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY", broker: "env" },
    { id: "workspace-oauth", type: "service-oauth", home: vercelConnectorHome("mcp.notion.com/notion-mcp") },
    { id: "user-oauth", type: "user-oauth", home: vercelConnectorHome("mcp.notion.com/notion-mcp") },
  ],
};

const kinds = (opts: readonly ConnectorOption[]): string[] => opts.map((o) => `${optionLabel(o)}:${o.route.kind}`);
const R = (over: Partial<Parameters<typeof resolveConnectorOptions>[0]>) =>
  resolveConnectorOptions({
    catalogue: NOTION,
    platform: "slack",
    mode: "channel",
    isAdmin: true,
    isOrgAdmin: over.isAdmin ?? true,
    hostWriteBroker: true,
    ...over,
  });

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

  const NARROW: ConnectorCredentials = { connector: "narrow", allows: ["user-oauth"], credentials: NOTION.credentials };
  eq(kinds(resolveConnectorOptions({ catalogue: NARROW, platform: "slack", mode: "dm", isAdmin: true, isOrgAdmin: true, hostWriteBroker: true })), ["Connect my account:url"], "allowlist ⇒ only user-oauth offered though api-key/service-oauth creds exist");

  const OAUTHLESS: ConnectorCredentials = { connector: "k", allows: ["api-key"], credentials: [{ id: "key", type: "api-key", secretRef: "K_KEY", broker: "env" }] };
  eq(kinds(resolveConnectorOptions({ catalogue: OAUTHLESS, platform: "slack", mode: "channel", isAdmin: true, isOrgAdmin: true, hostWriteBroker: true })), ["Set API key:modal"], "api-key-only provider ⇒ just the api-key option");

  const PLUMBING_FIRST: ConnectorCredentials = {
    connector: "notion",
    allows: ["api-key"],
    credentials: [
      { id: "channel-key", type: "api-key", secretRef: "NOTION_CHANNEL_API_KEY", broker: "env", intake: false },
      { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY", broker: "env" },
    ],
  };
  const plumbOpts = resolveConnectorOptions({ catalogue: PLUMBING_FIRST, platform: "slack", mode: "channel", isAdmin: true, isOrgAdmin: true, hostWriteBroker: true });
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
  ok(hostWriteHomeAvailable([fakeHome("vaultx", true)]) === true, "hostWriteHomeAvailable: a registered vendor home reporting host-write ⇒ available");
  ok(hostWriteHomeAvailable([fakeHome("db", true), fakeHome("env", false)]) === true, "hostWriteHomeAvailable: the db home reporting host-write ⇒ available");
  ok(hostWriteHomeAvailable([]) === false, "hostWriteHomeAvailable: no homes ⇒ false (fail closed)");

  eq(kinds(R({ mode: "channel", isAdmin: true, hostWriteBroker: true })), ["Connect org account:url", "Set API key:modal"], "vendor-home-armed (hostWriteBroker true via a registered home) ⇒ api-key offered as a modal, no db broker needed");
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

const DOMAINS: Domain[] = [
  { name: "org", match: "org", admins: ["slack/T1/U_ADMIN"] },
  { name: "eng", reach: ["slack/T1/C_DOM"], admins: ["slack/T1/U_DOM_ADMIN"] },
];
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
  loadConnectorCredentials: () => [NOTION],
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
  eq(st.calls.length, 0, "a service-oauth credential WITH a dashboardUrl calls no startAuthorization — Connect's hosted flow rejects app subjects");
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
  const orgDeps = (over: Record<string, unknown> = {}) => ({ loadConnectorCredentials: () => [NOTION_ORG_MINT], loadDomains: () => DOMAINS, ...over });
  const issuedRows = async () => (await readAudit({ org: ORG })).filter((r) => r.action === "connector.oauth_url_issued");
  const appSubject = (rows: readonly { detail?: unknown }[]) => rows.filter((r) => JSON.stringify(r.detail).includes('"subject":"app"')).length;
  const startRows = await issuedRows();
  const before = startRows.length;
  const appBefore = appSubject(startRows);
  const rec = recorder();
  const st = starter();
  ok((await handleConnectClick(click("service-oauth", "U_ADMIN", "C123"), orgDeps({ post: rec.post, startAuth: st.startAuth }))) === true, "org-mint service-oauth admin click handled");
  eq(st.calls.length, 1, "🔴 …and it MINTS — exactly one startAuthorization call (the dashboard route would make zero)");
  eq(st.calls[0].subject, { type: "app" }, "🔴 …for the APP subject — no principal id, so the vault row belongs to the org and to nobody");
  eq(st.calls[0].vc, "mcp.notion.com/notion-mcp", "…against the credential's own OAuth home ref");
  eq(st.calls[0].expiresInMs, AUTH_URL_TTL_MS, "…with the short capability TTL every OE authorization URL carries");
  ok(rec.methods().includes("chat.postEphemeral"), "the URL is delivered EPHEMERALLY (clicker-only), never into the room");
  ok(rec.calls.some((c) => c.body.includes(encodeURIComponent(FAKE_URL)) || c.body.includes(FAKE_URL)), "the ephemeral post carries the URL");

  const rows = await issuedRows();
  eq(rows.length, before + 1, "audit: exactly one new connector.oauth_url_issued row");
  eq(appSubject(rows), appBefore + 1, "🔴 audit: the new row names subject 'app' — an operator can tell an org mint from a personal one");
  ok(!rows.some((r) => JSON.stringify(r.detail).includes(FAKE_URL)), "🔴 …and NO audit row carries the capability URL");

  const rec2 = recorder();
  const st2 = starter();
  await handleConnectClick(click("service-oauth", "U_MEMBER", "C123"), orgDeps({ post: rec2.post, startAuth: st2.startAuth }));
  eq(st2.calls.length, 0, "🔴 a NON-admin mints NO org credential even on the mint route — the standing is re-derived host-side, never read off the card");
  ok(rec2.methods().includes("chat.postEphemeral"), "…and gets a refusal notice");

  const recDom = recorder();
  const stDom = starter();
  ok(
    (await handleConnectClick(click("service-oauth", "U_DOM_ADMIN", "C_DOM"), orgDeps({ post: recDom.post, startAuth: stDom.startAuth }))) === true,
    "a domain admin's org-mint click is still ours (handled, never forwarded)",
  );
  eq(stDom.calls.length, 0, "🔴 a DOMAIN admin mints NO org credential on the mint route — one domain's admin cannot bind the credential every domain spends");
  ok(
    recDom.calls.some((c) => decodeURIComponent(c.body.replace(/\+/g, " ")).includes("ORG admin")),
    "…and the refusal says WHY: it takes an org admin, not that they lack standing altogether",
  );

  const recOrg = recorder();
  const stOrg = starter();
  await handleConnectClick(click("service-oauth", "U_ADMIN", "C_DOM"), orgDeps({ post: recOrg.post, startAuth: stOrg.startAuth }));
  eq(stOrg.calls.length, 1, "🔴 …while an ORG admin on that same channel mints exactly once — the gate is org-admin, not admin-nobody");
  eq(stOrg.calls[0].subject, { type: "app" }, "…for the app subject, as before");

  const recDash = recorder();
  const stDash = starter();
  await handleConnectClick(click("service-oauth", "U_DOM_ADMIN", "C_DOM"), deps({ post: recDash.post, startAuth: stDash.startAuth }));
  eq(stDash.calls.length, 0, "the dashboard route mints nothing (as ever)");
  ok(
    recDash.calls.some((c) => decodeURIComponent(c.body.replace(/\+/g, " ")).includes("https://vercel.com/team-x/~/connect/scl_TEST")),
    "🔴 …and a DOMAIN admin still gets the dashboard link — the org-admin bar is on the MINT route only",
  );
}

{
  const orgOpt = resolveConnectorOptions({ catalogue: NOTION_ORG_MINT, platform: "discord", mode: "channel", isAdmin: true, isOrgAdmin: true, hostWriteBroker: true })
    .filter((o) => o.credentialType === "service-oauth");
  eq(orgOpt.length, 1, "the org option is offered on a non-Slack surface for an admin");
  ok(orgOpt[0].dashboardUrl === undefined, "…and it carries no dashboardUrl, so it takes the mint route");

  const st = starter();
  const minted = await renderNonSlackConnect("notion", orgOpt, { mode: "dm", org: ORG, platform: "discord", workspace: "G1" }, st.startAuth);
  eq(st.calls.length, 1, "renderNonSlackConnect MINTS the org option in a DM");
  eq(st.calls[0].subject, { type: "app" }, "🔴 …for the APP subject, exactly as the Slack click does");
  ok(minted.text.includes(FAKE_URL), "the URL lives ONLY in the returned text, which the caller host-posts");
  eq(minted.issued.map((o) => o.credentialId), ["workspace-oauth"], "🔴 …and the option is reported as ISSUED, so the caller writes its connector.oauth_url_issued row");

  const stCh = starter();
  const inChannel = await renderNonSlackConnect("notion", orgOpt, { mode: "channel", org: ORG, platform: "discord", workspace: "G1" }, stCh.startAuth);
  eq(stCh.calls.length, 0, "🔴 …and it mints NOTHING on a CHANNEL — the text is host-posted into the room, so an org URL there is a credential anybody present could claim");
  ok(!inChannel.text.includes(FAKE_URL), "🔴 …so no capability URL reaches the room");
  eq(inChannel.issued.length, 0, "…and nothing is reported as issued, so no oauth_url_issued row claims a mint that never happened");
  ok(inChannel.text.includes("message me directly"), "…and the degrade line names the working path instead of failing silently");

  const dashOpt = resolveConnectorOptions({ catalogue: NOTION, platform: "discord", mode: "channel", isAdmin: true, isOrgAdmin: true, hostWriteBroker: true })
    .filter((o) => o.credentialType === "service-oauth");
  const st2 = starter();
  const linked = await renderNonSlackConnect("notion", dashOpt, { mode: "channel", org: ORG, platform: "discord", workspace: "G1" }, st2.startAuth);
  eq(st2.calls.length, 0, "🔴 …and a credential that DOES declare a dashboardUrl still mints NOTHING");
  ok(linked.text.includes("https://vercel.com/team-x/~/connect/scl_TEST"), "…it posts the dashboard link instead");
  eq(linked.issued.length, 0, "…and issues no URL, so no oauth_url_issued row is written for it");

  const memberOpts = resolveConnectorOptions({ catalogue: NOTION_ORG_MINT, platform: "discord", mode: "channel", isAdmin: false, isOrgAdmin: false, hostWriteBroker: true });
  eq(memberOpts.filter((o) => o.credentialType === "service-oauth").length, 0, "🔴 a non-admin is offered NO org option on a non-Slack surface");
}

{
  const opts = (over: { isAdmin: boolean; isOrgAdmin: boolean }, catalogue = NOTION_ORG_MINT) =>
    resolveConnectorOptions({ catalogue, platform: "discord", mode: "channel", hostWriteBroker: true, ...over }).filter(
      (o) => o.credentialType === "service-oauth",
    );

  eq(opts({ isAdmin: true, isOrgAdmin: false }).length, 0, "🔴 a DOMAIN admin is NOT offered the org-subject MINT option — gate 2b withholds it, so no surface ever posts them the button");
  eq(opts({ isAdmin: true, isOrgAdmin: true }).length, 1, "🔴 …and an ORG admin IS offered it. Without this half the assertion above would pass for an option offered to nobody");

  eq(opts({ isAdmin: true, isOrgAdmin: false }, NOTION).length, 1, "🔴 a domain admin is STILL offered the dashboard-route org option — gate 2b reads the mint route, not the credential type");

  const mintCred = NOTION_ORG_MINT.credentials.find((c) => c.id === "workspace-oauth")!;
  const dashCred = NOTION.credentials.find((c) => c.id === "team-oauth")!;
  eq(unqualifiedAppRowMintHome("service-oauth", mintCred), "mcp.notion.com/notion-mcp", "the shared predicate names the OAuth home for a mint-route credential");
  eq(unqualifiedAppRowMintHome("service-oauth", dashCred), undefined, "…and nothing for one that declares a dashboardUrl");
  eq(unqualifiedAppRowMintHome("user-oauth", mintCred), undefined, "…and nothing for a user-subject type, whose row is qualified by its principal");
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
  ok(intakeCalls[0].ref === "db:notion:team-key" && intakeCalls[0].requestedBy === "U_ADMIN" && intakeCalls[0].connector === "notion", "the intake is asked for the credential's reversible db ref (db:notion:team-key), on behalf of the clicker");

  const intakeCalls2: Array<Record<string, unknown>> = [];
  const requestIntake2 = async (input: Record<string, unknown>) => {
    intakeCalls2.push(input);
    return { id: "y" };
  };
  const rec2 = recorder();
  await handleConnectClick(click("api-key", "U_MEMBER", "C123"), deps({ post: rec2.post, requestIntake: requestIntake2 }));
  eq(intakeCalls2.length, 0, "api-key by a NON-admin does NOT open the intake (standing re-verified)");

  const NOTION_WITH_PLUMBING: ConnectorCredentials = {
    connector: "notion",
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
    deps({ loadConnectorCredentials: () => [NOTION_WITH_PLUMBING], post: rec3.post, requestIntake: requestIntake3 }),
  );
  eq(intakeCalls3.length, 1, "admin api-key click against the plumbing-carrying provider ⇒ intake invoked");
  ok(intakeCalls3[0].ref === "db:notion:team-key", "the forged api-key click resolves the intake-able team-key (db:notion:team-key), NEVER the intake:false channel-key plumbing");
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
