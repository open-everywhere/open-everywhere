import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const dir = join(tmpdir(), `oe-intake-page-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
const ORG = "default";
const AES_KEY = randomBytes(32).toString("base64");
const SIGN_KEY = randomBytes(32).toString("base64");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = AES_KEY;
process.env.OE_INTAKE_PAGE_SIGNING_KEY = SIGN_KEY;
process.env.OE_PUBLIC_BASE_URL = "https://oe.example.test";

const SENTINEL = "sk-PAGE-SECRET-VALUE-1a2b3c4d5e6f-DO-NOT-LEAK";

const page = await import("../agent/credentials/intake-page.js");
const intake = await import("../agent/credentials/intake.js");
const dbBroker = await import("../agent/credentials/db-broker.js");
const { getSecretVia } = await import("../agent/access/credentials.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { resolveConnectorOptions, optionLabel, SURFACE_INTAKE_CAPS } = await import("../agent/connections/connector-offer.js");
const { dbCredentialRef } = await import("../agent/credentials/ref.js");
const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
const vault = encryptedKvVault();
const { resetSelfSecretCache } = await import("../agent/credentials/self-secrets.js");
type ConnectorCredentials = import("../agent/access/connector-credentials.js").ConnectorCredentials;
type ConnectorOption = import("../agent/connections/connector-offer.js").ConnectorOption;

dbBroker.registerDbCredentialBroker();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

function postReq(token: string, value: string): Request {
  const body = new URLSearchParams();
  body.set("t", token);
  body.set("k", value);
  return new Request(`https://oe.example.test${page.INTAKE_PAGE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
function getReq(token: string): Request {
  return new Request(`https://oe.example.test${page.INTAKE_PAGE_PATH}?t=${encodeURIComponent(token)}`);
}

console.log("1. token codec:");
{
  const now = 1_800_000_000_000;
  const claims = { v: 1 as const, org: ORG, id: "intake-abc", rb: "U_OWNER", exp: now + 15 * 60 * 1000 };
  const token = page.mintIntakePageToken(claims, SIGN_KEY);

  eq(page.verifyIntakePageToken(token, SIGN_KEY, now), claims, "round-trip: a freshly minted token verifies back to its claims");
  ok(page.verifyIntakePageToken(token, SIGN_KEY, claims.exp) === null, "expiry: a token at/after exp is rejected");
  ok(page.verifyIntakePageToken(token, SIGN_KEY, claims.exp + 1) === null, "expiry: a token past exp is rejected");

  const [payloadB64, sigB64] = token.split(".");
  const flippedSig = sigB64.slice(0, -1) + (sigB64.at(-1) === "A" ? "B" : "A");
  ok(page.verifyIntakePageToken(`${payloadB64}.${flippedSig}`, SIGN_KEY, now) === null, "tamper: a mutated signature is rejected (constant-time compare)");

  const evil = Buffer.from(JSON.stringify({ ...claims, id: "intake-OTHER" }), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  ok(page.verifyIntakePageToken(`${evil}.${sigB64}`, SIGN_KEY, now) === null, "wrong-row: re-pointing the payload id breaks the signature ⇒ rejected");

  ok(page.verifyIntakePageToken(token, randomBytes(32).toString("base64"), now) === null, "fail-closed: a token signed with a different key is rejected");

  for (const bad of ["", "no-dot", "a.b.c", ".", "x.", ".y"]) {
    ok(page.verifyIntakePageToken(bad, SIGN_KEY, now) === null, `malformed: "${bad}" is rejected`);
  }
  const v2 = page.mintIntakePageToken({ ...claims, v: 2 as unknown as 1 }, SIGN_KEY);
  ok(page.verifyIntakePageToken(v2, SIGN_KEY, now) === null, "version: an unknown claim version is rejected");
}

console.log("2. issueIntakePageLink:");
{
  const OWNER = "U_OWNER";
  const REF = dbCredentialRef("notion", "team-key");
  const t0 = new Date("2026-07-25T10:00:00Z");
  const res = await page.issueIntakePageLink(
    { org: ORG, connector: "notion", domain: "eng", ref: REF, requestedBy: OWNER, channelId: "C_DISCORD", platform: "discord" },
    { now: () => t0, mintId: () => "intake-link-1" },
  );
  ok(!!res && res.id === "intake-link-1", "issue: creates an intake row and returns its id");
  ok(!!res && res.url.startsWith("https://oe.example.test" + page.INTAKE_PAGE_PATH + "?t="), "issue: returns a URL on this deployment's base path");

  const tok = new URL(res!.url).searchParams.get("t")!;
  const claims = page.verifyIntakePageToken(tok, SIGN_KEY, t0.getTime());
  ok(!!claims && claims.id === "intake-link-1" && claims.rb === OWNER && claims.org === ORG, "issue: the link's token binds the row id + requester");

  const row = await getOperationalStore().getCredentialIntake(ORG, "intake-link-1");
  ok(!!row && row.usedAt === undefined && row.connector === "notion" && row.domain === "eng" && row.ref === REF, "issue: the intake row is persisted, unconsumed, with the right ref/labels");

  const aud = await readAudit({ org: ORG });
  ok(aud.some((r) => r.action === "credential.intake_requested" && r.platform === "discord"), "issue: audits credential.intake_requested on the real surface platform");

  resetSelfSecretCache();
  const mintedRes = await page.issueIntakePageLink(
    { org: ORG, connector: "notion", ref: REF, requestedBy: OWNER, channelId: "C_X", platform: "discord" },
    { env: { ...process.env, OE_INTAKE_PAGE_SIGNING_KEY: "" }, now: () => t0, mintId: () => "intake-link-mint" },
  );
  ok(mintedRes !== undefined, "issue: no signing key env var ⇒ STILL issues a link (mints on first use, OPE-408 step 3)");
  const mintedInVault = await vault.read("self:OE_INTAKE_PAGE_SIGNING_KEY");
  ok(typeof mintedInVault === "string" && mintedInVault.length > 0, "…and the minted key is durably stored under self:OE_INTAKE_PAGE_SIGNING_KEY");
  await vault.delete("self:OE_INTAKE_PAGE_SIGNING_KEY");
  resetSelfSecretCache();

  const savedRealKey = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  const unarmed = await page.issueIntakePageLink(
    { org: ORG, connector: "notion", ref: REF, requestedBy: OWNER, channelId: "C_X", platform: "discord" },
    { env: { ...process.env, OE_INTAKE_PAGE_SIGNING_KEY: SIGN_KEY }, now: () => t0 },
  );
  ok(unarmed === undefined, "issue: vault unarmed (no OE_CREDENTIAL_ENCRYPTION_KEY) ⇒ undefined (honest degrade)");
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = savedRealKey;

  const noBase = await page.issueIntakePageLink(
    { org: ORG, connector: "notion", ref: REF, requestedBy: OWNER, channelId: "C_X", platform: "discord" },
    { env: { OE_INTAKE_PAGE_SIGNING_KEY: SIGN_KEY }, now: () => t0 },
  );
  ok(noBase === undefined, "issue: no resolvable base URL ⇒ undefined");
}

console.log("3. GET:");
{
  const OWNER = "U_GETTER";
  const REF = dbCredentialRef("notion", "team-key");
  const t0 = new Date("2026-07-25T11:00:00Z");
  const link = await page.issueIntakePageLink(
    { org: ORG, connector: "notion", domain: "eng", ref: REF, requestedBy: OWNER, channelId: "C_G", platform: "teams" },
    { now: () => t0, mintId: () => "intake-get-1" },
  );
  const tok = new URL(link!.url).searchParams.get("t")!;

  const good = await page.handleIntakePageGet(getReq(tok), { now: () => t0 });
  ok(good.status === 200, "GET: a valid token renders 200");
  const html = await good.text();
  ok(html.includes("<form") && html.includes('name="t"') && html.includes('type="password"'), "GET: renders the entry form (hidden token + password input)");
  ok(html.includes("notion") && html.includes("eng"), "GET: shows the connector + domain to the token holder");
  ok(!html.includes(SENTINEL), "GET: renders no secret value (there is none yet)");

  const bad = await page.handleIntakePageGet(getReq("garbage.token"), { now: () => t0 });
  ok(bad.status === 404, "GET: a bad token → generic 404");

  const expired = await page.handleIntakePageGet(getReq(tok), { now: () => new Date(t0.getTime() + 20 * 60 * 1000) });
  ok(expired.status === 404, "GET: an expired token → generic 404");
  ok((await bad.text()) === (await (await page.handleIntakePageGet(getReq(tok), { now: () => new Date(t0.getTime() + 20 * 60 * 1000) })).text()), "GET: bad-token and expired-token pages are byte-identical (no oracle)");

  resetSelfSecretCache();
  const stillRoutable = await page.handleIntakePageGet(getReq(tok), { env: { ...process.env, OE_INTAKE_PAGE_SIGNING_KEY: "" }, now: () => t0 });
  ok(stillRoutable.status === 404, "GET: no signing key env var ⇒ 404 for THIS token (it mints a NEW key, so tok's old signature no longer verifies) — not a route-disarm 404");
  await vault.delete("self:OE_INTAKE_PAGE_SIGNING_KEY");
  resetSelfSecretCache();
  const savedRealKey = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  const disarmed = await page.handleIntakePageGet(getReq(tok), { env: { ...process.env, OE_INTAKE_PAGE_SIGNING_KEY: SIGN_KEY }, now: () => t0 });
  ok(disarmed.status === 404, "GET: vault unarmed ⇒ 404 (route effectively does not exist)");
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = savedRealKey;
}

console.log("4. POST:");
{
  const OWNER = "U_POSTER";
  const REF = dbCredentialRef("notion", "post-key");
  const t0 = new Date("2026-07-25T12:00:00Z");
  const link = await page.issueIntakePageLink(
    { org: ORG, connector: "notion", domain: "eng", ref: REF, requestedBy: OWNER, channelId: "C_P", platform: "teams" },
    { now: () => t0, mintId: () => "intake-post-1" },
  );
  const tok = new URL(link!.url).searchParams.get("t")!;

  const empty = await page.handleIntakePagePost(postReq(tok, "   "), { now: () => t0 });
  ok(empty.status === 200 && (await empty.text()).includes("<form"), "POST: an empty value re-renders the form");
  ok((await getOperationalStore().getCredentialIntake(ORG, "intake-post-1"))?.usedAt === undefined, "POST: an empty submit does NOT consume the intake (no burn)");

  const logs: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  let stored: Response;
  try {
    stored = await page.handleIntakePagePost(postReq(tok, SENTINEL), { now: () => t0 });
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
  ok(stored.status === 200, "POST: a valid submit stores and returns 200");
  const okHtml = await stored.text();
  ok(okHtml.includes("stored securely") && !okHtml.includes("<form"), "POST: the success page confirms + shows no form");

  ok((await getSecretVia("db", REF)) === SENTINEL, "POST: the value is retrievable through the db broker (shared store seam)");

  ok(!logs.some((l) => l.includes(SENTINEL)), "leak-proof: the secret appears in NO captured console output");
  ok(!okHtml.includes(SENTINEL), "leak-proof: the secret appears in NO rendered HTML");
  const aud = await readAudit({ org: ORG });
  const storedRow = aud.find((r) => r.action === "credential.stored" && (r.detail as Record<string, unknown> | undefined)?.ref === REF);
  ok(!!storedRow, "audit: a credential.stored row exists for the page-stored ref");
  ok(!!storedRow && storedRow.platform === "web" && storedRow.principalId === OWNER, "audit: credential.stored records platform=web + the requester (who), from the token");
  const detail = (storedRow!.detail ?? {}) as Record<string, unknown>;
  eq({ ref: detail.ref, connector: detail.connector, domain: detail.domain, id: detail.id }, { ref: REF, connector: "notion", domain: "eng", id: "intake-post-1" }, "audit: credential.stored detail = ref/connector/domain/id only");
  ok(!JSON.stringify(aud).includes(SENTINEL), "leak-proof: the secret appears in NO audit row (not even its length)");
  const persisted = await getOperationalStore().getStoredCredential(ORG, REF);
  ok(!!persisted && !persisted.ciphertext.includes(SENTINEL), "store: only ciphertext is persisted, never the plaintext");

  const again = await page.handleIntakePagePost(postReq(tok, SENTINEL), { now: () => t0 });
  ok(again.status === 404, "single-use: a second POST of a consumed token → generic 404");

  const getConsumed = await page.handleIntakePageGet(getReq(tok), { now: () => t0 });
  ok(getConsumed.status === 404, "single-use: GET on a consumed token → generic 404");
}

console.log("4b. slack parity via the shared seam:");
{
  const OWNER = "U_PARITY";
  const CH = "C_ORIGIN";
  const REF = dbCredentialRef("notion", "parity-key");
  const t0 = new Date("2026-07-25T13:00:00Z");
  const calls: { method: string; body: string }[] = [];
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true, ts: "1700159720.000100" } as Record<string, unknown>;
  };

  await intake.requestCredentialIntake(
    { org: ORG, connector: "notion", domain: "eng", ref: REF, requestedBy: OWNER, channelId: CH, teamId: "T1" },
    { post, now: () => t0, mintId: () => "intake-parity" },
  );

  const res = await intake.handleSetKeyViewSubmission(
    {
      type: "view_submission",
      user: { id: OWNER },
      team: { id: "T1" },
      view: {
        callback_id: intake.OE_SETKEY_MODAL_CALLBACK,
        private_metadata: JSON.stringify({ org: ORG, id: "intake-parity" }),
        state: { values: { [intake.SETKEY_INPUT_BLOCK]: { [intake.SETKEY_INPUT_ACTION]: { value: SENTINEL } } } },
      },
    },
    { post, now: () => t0 },
  );
  ok(res.handled === true && res.response === undefined, "parity: a submit with no channelId in metadata still succeeds");
  const confirm = calls.find((c) => c.method === "chat.postEphemeral");
  ok(!!confirm && new URLSearchParams(confirm.body).get("channel") === CH, "parity: the confirmation falls back to the intake row's ORIGIN channel");
  ok(!calls.some((c) => c.body.includes(SENTINEL)), "leak-proof: the confirmation post carries no secret value");
}

console.log("5. resolver page route:");
{
  const NOTION: ConnectorCredentials = {
    connector: "notion",
    allows: ["api-key"],
    credentials: [{ id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY", broker: "env" }],
  };
  const kinds = (opts: readonly ConnectorOption[]): string[] => opts.map((o) => `${optionLabel(o)}:${o.route.kind}`);

  eq(
    kinds(resolveConnectorOptions({ catalogue: NOTION, platform: "discord", mode: "channel", isAdmin: true, hostWriteBroker: true, intakePageAvailable: true })),
    ["Set API key:page"],
    "discord + page armed ⇒ api-key routes to the intake page",
  );
  eq(
    kinds(resolveConnectorOptions({ catalogue: NOTION, platform: "discord", mode: "channel", isAdmin: true, hostWriteBroker: true, intakePageAvailable: false })),
    ["Set API key:text-degrade"],
    "discord + page NOT armed ⇒ api-key degrades to text (no dead link)",
  );

  eq(
    kinds(resolveConnectorOptions({ catalogue: NOTION, platform: "slack", mode: "channel", isAdmin: true, hostWriteBroker: true, intakePageAvailable: true })),
    ["Set API key:modal"],
    "slack + page armed ⇒ still the native modal (page is the fallback for everyone else)",
  );

  eq(
    kinds(resolveConnectorOptions({ catalogue: NOTION, platform: "discord", mode: "channel", isAdmin: true, hostWriteBroker: false, intakePageAvailable: true })),
    ["Set API key:unavailable"],
    "no host-write broker ⇒ api-key unavailable even with the page armed",
  );

  for (const s of ["discord", "teams", "github", "linear", "notion"]) {
    ok(SURFACE_INTAKE_CAPS[s]?.pageLink === true, `caps: ${s} declares pageLink`);
  }
  ok(SURFACE_INTAKE_CAPS.slack?.pageLink === undefined && SURFACE_INTAKE_CAPS.slack?.secretModal === true, "caps: slack stays native-modal (no pageLink flip)");
}

console.log(`\n✅ intake-page: ${n} checks passed`);
