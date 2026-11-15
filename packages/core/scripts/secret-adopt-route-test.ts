// proves: CTRL-adopt_env_secrets

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-secret-adopt-route-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
_setDeploymentIdentityForTest({ org: "default" });
delete process.env.OE_CONTROL_READ_TOKENS;
delete process.env.OE_CONTROL_INJECT_TOKENS;

const { handleSecretAdopt, CONTROL_SECRET_ADOPT_PATH } = await import("../agent/control/secret-adopt-route.js");
const { resetControlSecretCache } = await import("../agent/control/control-secrets.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { getOperatorSecret, setOperatorSecret, resetOperatorSecretWarnings } = await import("../agent/credentials/operator-secrets.js");
const { registerOperatorSecretNames } = await import("../agent/ops/operator-secret-roster.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { runSecretCommand } = await import("./oe-secret.js");

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

const digest = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const INJECT_TOKEN = `inject-${randomBytes(12).toString("hex")}`;
const READ_TOKEN = `read-${randomBytes(12).toString("hex")}`;
const SENTINEL = "adopt-route-SENTINEL-VALUE-4c1d8e2a-DO-NOT-LEAK";
const SENTINEL_2 = "adopt-route-SENTINEL-ROTATED-9e7b3f50-DO-NOT-LEAK";
const ADOPT = "OE_LOG_SHIP_TOKEN";
const UNSET = "OE_TELEMETRY_OTLP_HEADERS";
const KEPT = "OE_EGRESS_PROXY_TOKEN";

const post = (body: unknown, token?: string) =>
  handleSecretAdopt(
    new Request(`https://deploy.example${CONTROL_SECRET_ADOPT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const adoptRows = async () => (await readAudit({ org: "default", limit: 500 })).filter((r) => r.action === "admin.secret.adopt_env");
const stored = async (name: string) => (await getOperationalStore().getStoredCredential("default", name)) !== null;

{
  process.env.OE_CONTROL_READ_TOKENS = `harness:${digest(READ_TOKEN)}`;
  resetControlSecretCache();
  const r = await post({ names: [ADOPT] }, READ_TOKEN);
  ok("404 while the injection-token family is unset, even with a read family configured", r.status === 404);

  process.env.OE_CONTROL_INJECT_TOKENS = `operator:${digest(INJECT_TOKEN)}`;
  resetControlSecretCache();
  ok("401 with no bearer", (await post({ names: [ADOPT] })).status === 401);
  ok("401 with a wrong bearer", (await post({ names: [ADOPT] }, "not-a-token")).status === 401);
  ok("🔴 401 with a READ-family bearer: the read family stays read-only (OPE-136)", (await post({ names: [ADOPT] }, READ_TOKEN)).status === 401);
  ok("…and no refused call stored anything", !(await stored(ADOPT)));
}

{
  process.env[ADOPT] = SENTINEL;
  delete process.env[UNSET];
  process.env[KEPT] = SENTINEL_2;
  await setOperatorSecret({ name: KEPT, value: "the-stored-rotation", setBy: "operator:cli" });

  const errorOf = async (r: Response) => ({ status: r.status, text: await r.text() });
  ok("400 on a body that is not JSON", (await post("not json", INJECT_TOKEN)).status === 400);
  ok("400 when `names` is not an array", (await post({ names: ADOPT }, INJECT_TOKEN)).status === 400);
  ok("400 on an empty name list", (await post({ names: [] }, INJECT_TOKEN)).status === 400);
  ok("400 when `overwrite` is not a boolean", (await post({ names: [ADOPT], overwrite: "yes" }, INJECT_TOKEN)).status === 400);
  const foreign = await errorOf(await post({ names: [ADOPT], org: "some-other-tenant" }, INJECT_TOKEN));
  ok("400 on a foreign org", foreign.status === 400 && foreign.text.includes("not this deployment's org"));

  process.env.OE_ADOPT_ROUTE_NOT_A_SECRET = SENTINEL;
  const off = await errorOf(await post({ names: [ADOPT, "OE_ADOPT_ROUTE_NOT_A_SECRET"] }, INJECT_TOKEN));
  ok("🔴 a name off the operator-secret roster is refused, by position", off.status === 400 && off.text.includes("names[1] is not an operator secret"));
  ok("…without echoing the name", !off.text.includes("OE_ADOPT_ROUTE_NOT_A_SECRET"));
  ok("…and the WHOLE call is refused: the valid name before it is not stored", !(await stored(ADOPT)));
  registerOperatorSecretNames(["DATABASE_URL"]);
  const root = await errorOf(await post({ names: ["DATABASE_URL"] }, INJECT_TOKEN));
  ok("🔴 a root-of-trust name is refused even when it is on the roster", root.status === 400 && root.text.includes("root-of-trust"));
  const pasted = await errorOf(await post({ names: [SENTINEL] }, INJECT_TOKEN));
  ok("🔴 a value pasted into the names field is refused and not echoed", pasted.status === 400 && !pasted.text.includes(SENTINEL));
  ok("no refused call wrote an adopt row", (await adoptRows()).length === 0);
}

{
  const res = await post({ names: [ADOPT, UNSET, KEPT] }, INJECT_TOKEN);
  const text = await res.text();
  const body = JSON.parse(text) as { ok: boolean; org: string; results: { name: string; outcome: string; replaced?: boolean }[] };
  const outcome = (name: string) => body.results.find((r) => r.name === name)?.outcome;
  ok("200 with one outcome per name", res.status === 200 && body.ok === true && body.org === "default" && body.results.length === 3);
  ok("`stored` for a name the env holds", outcome(ADOPT) === "stored");
  ok("`no-env-value` for a name the env does not hold", outcome(UNSET) === "no-env-value");
  ok("`already-stored` for a stored name, without overwrite", outcome(KEPT) === "already-stored");
  ok("🔴 the reply carries no value", !text.includes(SENTINEL) && !text.includes(SENTINEL_2));

  delete process.env[ADOPT];
  resetOperatorSecretWarnings();
  const resolved = await getOperatorSecret(ADOPT);
  ok("the adopted value now resolves from the db store", resolved.source === "db" && resolved.value === SENTINEL);
  ok(
    "…stamped with the env-adopt provenance and the inject principal",
    (await getOperationalStore().getStoredCredential("default", ADOPT))?.createdBy === "operator:env-adopt:svc:operator",
  );
  ok("the stored row is kept: the env value does not replace it without overwrite", (await getOperatorSecret(KEPT)).value === "the-stored-rotation");

  const rows = await adoptRows();
  ok("one admin.secret.adopt_env row, under the inject principal", rows.length === 1 && rows[0].principalId === "svc:operator");
  ok("…naming each secret and its outcome", JSON.stringify(rows[0].detail).includes(`"${UNSET}":"no-env-value"`) && JSON.stringify(rows[0].detail).includes(`"${ADOPT}":"stored"`));
  const all = await readAudit({ org: "default", limit: 500 });
  ok("🔴 no audit row carries a value", !JSON.stringify(all).includes(SENTINEL) && !JSON.stringify(all).includes(SENTINEL_2));
  const calls = all.filter((r) => r.action === "control.service_call" && (r.detail as { view?: string }).view === "secret_adopt");
  ok("every authenticated call writes a control.service_call row (the 9 so far)", calls.length === 9);

  const over = JSON.parse(await (await post({ names: [KEPT], overwrite: true }, INJECT_TOKEN)).text()) as typeof body;
  ok("overwrite:true replaces a stored row and says so", over.results[0].outcome === "stored" && over.results[0].replaced === true);
  ok("…with the env value", (await getOperatorSecret(KEPT)).value === SENTINEL_2);
}

{
  const st = getOperationalStore() as unknown as { putStoredCredential: (...a: unknown[]) => Promise<void> };
  const realPut = st.putStoredCredential;
  st.putStoredCredential = async () => {
    throw new Error(`constraint failed near '${SENTINEL_2}'`);
  };
  try {
    const fault = await post({ names: [UNSET, KEPT], overwrite: true }, INJECT_TOKEN);
    const text = await fault.text();
    ok("a store fault answers 500 and names the secret", fault.status === 500 && text.includes(`adopting ${KEPT} failed`));
    ok("🔴 …with the value scrubbed out", !text.includes(SENTINEL_2) && text.includes("[redacted]"));
    const rows = await adoptRows();
    ok("🔴 …and the fault row carries no value", rows.length === 3 && !JSON.stringify(rows).includes(SENTINEL_2));
  } finally {
    st.putStoredCredential = realPut;
  }
}

{
  const DEPLOY = "https://deploy.example";
  process.env.OE_LOG_SHIP_TOKEN = SENTINEL;
  const sent: { url: string; auth: string | null; body: string }[] = [];
  const deployment: typeof fetch = async (input, init) => {
    const req = new Request(input as URL, init);
    sent.push({ url: req.url, auth: req.headers.get("authorization"), body: await req.clone().text() });
    return handleSecretAdopt(req);
  };
  const run = async (args: string[], stdin: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSecretCommand(args, { out: (l) => out.push(l), err: (l) => err.push(l), readStdin: async () => stdin, fetch: deployment });
    return { code, text: [...out, ...err].join("\n") };
  };

  const good = await run(["adopt", ADOPT, UNSET, "--url", DEPLOY, "--overwrite"], `${INJECT_TOKEN}\n`);
  ok("`oe secret adopt` exits 0 and prints each name with its outcome", good.code === 0 && good.text.includes(`${ADOPT}: stored (replaced)`) && good.text.includes(`${UNSET}: no-env-value`));
  ok("…calls the deployment's adopt route with the stdin token as the bearer", sent.at(-1)?.url === `${DEPLOY}${CONTROL_SECRET_ADOPT_PATH}` && sent.at(-1)?.auth === `Bearer ${INJECT_TOKEN}`);
  ok("…with the names and the overwrite flag", JSON.parse(sent.at(-1)!.body).overwrite === true && JSON.parse(sent.at(-1)!.body).names.length === 2);
  ok("🔴 …and prints neither a value nor the token", !good.text.includes(SENTINEL) && !good.text.includes(INJECT_TOKEN));

  const json = await run(["adopt", KEPT, "--url", DEPLOY, "--json"], INJECT_TOKEN);
  ok("`--json` prints the results", json.code === 0 && (JSON.parse(json.text) as { results: { outcome: string }[] }).results[0].outcome === "already-stored");

  const refused = await run(["adopt", ADOPT, "--url", DEPLOY], READ_TOKEN);
  ok("a refused token exits 1 and names the injection-token family", refused.code === 1 && refused.text.includes("OE_CONTROL_INJECT_TOKENS") && !refused.text.includes(READ_TOKEN));
  const offRoster = await run(["adopt", "OE_ADOPT_ROUTE_NOT_A_SECRET", "--url", DEPLOY], INJECT_TOKEN);
  ok("a refused name exits 1 with the route's position-only reason", offRoster.code === 1 && offRoster.text.includes("names[0] is not an operator secret"));

  const before = sent.length;
  ok("plain http to a remote host is refused before any call", (await run(["adopt", ADOPT, "--url", "http://deploy.example"], INJECT_TOKEN)).code === 2 && sent.length === before);
  ok("an empty token is refused before any call", (await run(["adopt", ADOPT, "--url", DEPLOY], "\n")).code === 1 && sent.length === before);
  ok("no --url is a usage error", (await run(["adopt", ADOPT], INJECT_TOKEN)).code === 2);
  ok("no name is a usage error", (await run(["adopt", "--url", DEPLOY], INJECT_TOKEN)).code === 2);

  delete process.env.OE_CONTROL_INJECT_TOKENS;
  resetControlSecretCache();
  const dark = await run(["adopt", ADOPT, "--url", DEPLOY], INJECT_TOKEN);
  ok("a deployment with no injection-token family: the route 404s and the command says why", dark.code === 1 && dark.text.includes("404") && dark.text.includes("OE_CONTROL_INJECT_TOKENS"));
}

delete process.env.OE_LOG_SHIP_TOKEN;
delete process.env[KEPT];
delete process.env.OE_ADOPT_ROUTE_NOT_A_SECRET;
await removeTempDir(dir);
console.log(`secret-adopt-route-test: ${n} assertions passed`);
