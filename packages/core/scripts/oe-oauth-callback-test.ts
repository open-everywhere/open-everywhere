import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const dir = join(tmpdir(), `oe-oauth-cb-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
const ORG = "default";
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const cb = await import("../agent/connections/oe-oauth-callback.js");
import type { OeOauthCallbackCompleter } from "../agent/connections/oe-oauth-callback.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const vault = encryptedKvVault();
  const value = JSON.stringify({ accessToken: "AT-SECRET-123", refreshToken: "RT-SECRET-456" });
  await vault.write("oe-oauth:tok:notion:app", value, { connector: "notion" });
  ok((await vault.read("oe-oauth:tok:notion:app")) === value, "vault round-trips the JSON value");
  ok((await vault.read("oe-oauth:tok:notion:missing")) === null, "vault read of an unknown ref is null");

  const row = await getOperationalStore().getStoredCredential(ORG, "oe-oauth:tok:notion:app");
  ok(!!row && row.ciphertext !== value, "value is encrypted at rest (ciphertext ≠ plaintext)");
  ok(!!row && !row.ciphertext.includes("AT-SECRET-123") && !row.ciphertext.includes("RT-SECRET-456"), "no token substring leaks into the stored ciphertext");

  const saved = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  let threw = false;
  try {
    await vault.write("oe-oauth:tok:notion:app", "x");
  } catch {
    threw = true;
  }
  ok(threw, "vault fail-closed: write refuses with no AES key");
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = saved;
}

{
  const vault = encryptedKvVault();
  await vault.write("counter", JSON.stringify({ v: 0 }));
  const N = 25;
  await Promise.all(
    Array.from({ length: N }, () =>
      vault.withLock("counter", async () => {
        const cur = JSON.parse((await vault.read("counter"))!) as { v: number };
        await new Promise((r) => setTimeout(r, 1));
        await vault.write("counter", JSON.stringify({ v: cur.v + 1 }));
      }),
    ),
  );
  const final = JSON.parse((await vault.read("counter"))!) as { v: number };
  ok(final.v === N, `withLock serialised ${N} read-modify-writes with no lost update (got ${final.v})`);
}

{
  const P = cb.OE_OAUTH_CALLBACK_PATH;
  const call = (query: string, completer: OeOauthCallbackCompleter | null) => cb.handleOeOauthCallback(new Request(`https://oe.example${P}${query}`), completer);

  ok(P === "/oauth/v1/callback", "callback path is /oauth/v1/callback");
  ok((await call("?state=s&code=c", null)).status === 404, "no completer ⇒ 404 (fail closed)");
  ok((await call("?code=c", async () => ({ ok: true }))).status === 400, "missing state ⇒ 400");
  ok((await call("?state=s", async () => ({ ok: true }))).status === 400, "missing code ⇒ 400");
  ok((await call("?error=access_denied", async () => ({ ok: true }))).status === 400, "provider error ⇒ 400");

  const okRes = await call("?state=s&code=c", async () => ({ ok: true, connectionName: "notion" }));
  ok(okRes.status === 200 && (await okRes.text()).includes("notion"), "ok completer ⇒ 200 naming the connection");

  ok((await call("?state=s&code=c", async () => ({ ok: false, detail: "bad" }))).status === 502, "ok:false ⇒ 502");
  ok((await call("?state=s&code=c", async () => { throw new Error("boom"); })).status === 502, "completer throw ⇒ 502");

  const leaky = await call("?state=s&code=AUTHCODE-SECRET", async () => ({ ok: true, connectionName: "notion" }));
  ok(!(await leaky.text()).includes("AUTHCODE-SECRET"), "authorization code never rendered into the page");
}

{
  const P = cb.OE_OAUTH_CALLBACK_PATH;
  type Row = Parameters<typeof import("../agent/audit/audit.js").appendAudit>[0];
  const rows: Row[] = [];
  const deps = { audit: async (e: Row) => void rows.push(e), org: () => "test-org" };
  const call = (completer: OeOauthCallbackCompleter) =>
    cb.handleOeOauthCallback(new Request(`https://oe.example${P}?state=s&code=CODE-SECRET`), completer, deps);

  const appRes = await call(async () => ({ ok: true, connectionName: "mcp.notion.com/notion-mcp", subject: { type: "app" as const }, rebound: false }));
  ok(appRes.status === 200, "an app-subject completion still renders 200");
  ok(rows.length === 1 && rows[0].action === "connector.credential_bound", "🔴 a completion writes exactly one connector.credential_bound row");
  ok(rows[0].org === "test-org" && rows[0].platform === "oauth" && rows[0].workspace === "callback", "…addressed to the deployment's org on the callback's own platform/workspace");
  ok(rows[0].detail?.connector === "mcp.notion.com/notion-mcp", "…naming the connector that was bound");
  ok(rows[0].detail?.subject === "app", "🔴 …and the SUBJECT TYPE — `app` is the deployment-wide row every granting domain spends");
  ok(rows[0].detail?.rebound === false, "…with rebound FALSE on a first bind (the negative control for the flag below)");
  ok(rows[0].principalId === undefined, "🔴 …and NO principalId on an app subject: the callback authenticates nobody, so naming one would be a guess");
  ok(!JSON.stringify(rows[0]).includes("mcp.notion.com/notion-mcp:app"), "…and no vault KEY is written into the row either");
  ok(!JSON.stringify(rows[0]).includes("CODE-SECRET"), "🔴 …and no authorization code reaches the ledger");

  rows.length = 0;
  await call(async () => ({ ok: true, connectionName: "mcp.notion.com/notion-mcp", subject: { type: "app" as const }, rebound: true }));
  ok(rows.length === 1 && rows[0].detail?.rebound === true, "🔴 a REBIND is recorded as rebound:true — the second admin's silent replacement is now in the ledger");

  rows.length = 0;
  await call(async () => ({ ok: true, connectionName: "notion", subject: { type: "user" as const, id: "p:default/slack/T1/U9" }, rebound: false }));
  ok(rows.length === 1 && rows[0].detail?.subject === "user", "a user-subject completion is audited as subject `user`");
  ok(rows[0].principalId === undefined, "🔴 …and names NO principal either: the only id in reach is the VAULT SUBJECT, and the ledger's principal_id holds the BARE vendor id with the platform in its own column");
  ok(!JSON.stringify(rows[0]).includes("p:default/slack/T1/U9"), "🔴 …so the qualified vault subject reaches no column of the row — a row keyed by it would bucket away from every other row that person produced");

  rows.length = 0;
  ok((await call(async () => ({ ok: false, detail: "exchange rejected", subject: { type: "app" as const }, rebound: true }))).status === 502, "a rejected exchange still renders 502");
  ok(rows.length === 0, "🔴 a FAILED completion writes NO credential_bound row — nothing was bound");
  ok((await call(async () => ({ ok: true, connectionName: "notion" }))).status === 200, "a completer that reports no subject still renders 200");
  ok(rows.length === 0, "🔴 …and writes NO row either — the route never guesses a subject it was not told");

  const throwing = await cb.handleOeOauthCallback(
    new Request(`https://oe.example${P}?state=s&code=c`),
    async () => ({ ok: true, connectionName: "notion", subject: { type: "app" as const }, rebound: false }),
    { audit: async () => { throw new Error("store down"); }, org: () => "test-org" },
  );
  ok(throwing.status === 200, "an audit-write failure never breaks the callback page");
}

{
  cb.resetOeOauthCallbackCompleter();
  ok(cb.resolveOeOauthCallbackCompleter() === null, "resolve is null after reset (fail closed)");
  const c: OeOauthCallbackCompleter = async () => ({ ok: true });
  cb.registerOeOauthCallbackCompleter(c);
  ok(cb.resolveOeOauthCallbackCompleter() === c, "resolve returns the registered completer");
  cb.resetOeOauthCallbackCompleter();
}

console.log(`✓ oe-oauth-callback: ${n} assertions passed (kv vault, single-flight lock, callback route)`);
