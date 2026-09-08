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
  cb.resetOeOauthCallbackCompleter();
  ok(cb.resolveOeOauthCallbackCompleter() === null, "resolve is null after reset (fail closed)");
  const c: OeOauthCallbackCompleter = async () => ({ ok: true });
  cb.registerOeOauthCallbackCompleter(c);
  ok(cb.resolveOeOauthCallbackCompleter() === c, "resolve returns the registered completer");
  cb.resetOeOauthCallbackCompleter();
}

console.log(`✓ oe-oauth-callback: ${n} assertions passed (kv vault, single-flight lock, callback route)`);
