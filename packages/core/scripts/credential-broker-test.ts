import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const dir = join(tmpdir(), `oe-credential-broker-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
const ORG = "default";
const KEY = randomBytes(32).toString("base64");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = KEY;

const SENTINEL = "sk-SUPER-SECRET-VALUE-9f8e7d6c5b4a-DO-NOT-LEAK";

const { getOperationalStore } = await import("../agent/operational/provider.js");
const { getSecretVia, brokerFor, resolveHeaders, registerBroker, resetBrokers, CredentialError } = await import("../agent/access/credentials.js");
const dbBroker = await import("../agent/credentials/db-broker.js");
const intake = await import("../agent/credentials/intake.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { runtimeRoleGrantsSql } = await import("../agent/operational/postgres.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function recorder() {
  const calls: { method: string; body: string }[] = [];
  const post = async (method: string, body: string) => {
    calls.push({ method, body });
    return { ok: true, ts: "1700159720.000100" } as Record<string, unknown>;
  };
  return { post, calls, methods: () => calls.map((c) => c.method) };
}

{
  await dbBroker.storeDbSecret({ org: ORG, ref: "db:notion-eng-key", plaintext: SENTINEL, provider: "notion", domain: "eng", createdBy: "U_OWNER" });

  const broker = dbBroker.makeDbCredentialBroker();
  ok((await broker.getSecret("db:notion-eng-key")) === SENTINEL, "broker: getSecret round-trips the stored plaintext");

  resetBrokers();
  dbBroker.registerDbCredentialBroker();
  ok((await getSecretVia("db", "db:notion-eng-key")) === SENTINEL, "seam: getSecretVia('db', ref) resolves through the registered db broker");

  await assert.rejects(() => getSecretVia("db", "db:does-not-exist"), (e) => e instanceof CredentialError && /secret not found/.test((e as Error).message), "seam: a missing ref is a CredentialError");

  await dbBroker.storeDbSecret({ org: ORG, ref: "db:iv-a", plaintext: SENTINEL, createdBy: "U_OWNER" });
  await dbBroker.storeDbSecret({ org: ORG, ref: "db:iv-b", plaintext: SENTINEL, createdBy: "U_OWNER" });
  const a = await getOperationalStore().getStoredCredential(ORG, "db:iv-a");
  const b = await getOperationalStore().getStoredCredential(ORG, "db:iv-b");
  ok(!!a && !!b && a.ciphertext !== b.ciphertext, "broker: same plaintext ⇒ different ciphertext (random IV per store)");
  ok(!!a && !a.ciphertext.includes(SENTINEL), "broker: the stored ciphertext does not contain the plaintext");
  ok((await getSecretVia("db", "db:iv-a")) === SENTINEL && (await getSecretVia("db", "db:iv-b")) === SENTINEL, "broker: both distinct ciphertexts decrypt back to the same plaintext");
}

{
  const saved = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;

  delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  await assert.rejects(() => dbBroker.storeDbSecret({ org: ORG, ref: "db:x", plaintext: "v", createdBy: "U" }), (e) => e instanceof CredentialError && /OE_CREDENTIAL_ENCRYPTION_KEY/.test((e as Error).message), "fail-closed: store refuses with the key env absent (names the env)");
  await assert.rejects(() => dbBroker.makeDbCredentialBroker().getSecret("db:notion-eng-key"), (e) => e instanceof CredentialError && /OE_CREDENTIAL_ENCRYPTION_KEY/.test((e as Error).message), "fail-closed: read refuses with the key env absent");

  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
  await assert.rejects(() => dbBroker.storeDbSecret({ org: ORG, ref: "db:x", plaintext: "v", createdBy: "U" }), (e) => e instanceof CredentialError && /32/.test((e as Error).message), "fail-closed: store refuses a non-32-byte key");

  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = saved;
}

{
  const OWNER = "U_OWNER";
  const OTHER = "U_OTHER";
  const CH = "C_KEYS";
  const t0 = new Date("2026-07-20T10:00:00Z");
  let idCounter = 0;
  const mintId = () => `intake-${++idCounter}`;

  const rq = recorder();
  const { id } = await intake.requestCredentialIntake(
    { org: ORG, provider: "notion", domain: "eng", ref: "db:notion-eng-key-2", requestedBy: OWNER, channelId: CH, teamId: "T1" },
    { post: rq.post, now: () => t0, mintId },
  );
  ok(rq.methods().includes("chat.postMessage"), "intake: requestCredentialIntake posts the Set API key button");
  ok((await getOperationalStore().getCredentialIntake(ORG, id)) !== null, "intake: the pending intake row is persisted");

  const click = (user: string) => ({ type: "block_actions", trigger_id: "TRIGGER", user: { id: user }, channel: { id: CH }, actions: [{ action_id: `${intake.OE_SETKEY_ACTION_PREFIX}${id}`, value: ORG }] });

  const wrong = recorder();
  ok((await intake.handleSetKeyClick(click(OTHER), { post: wrong.post, now: () => t0 })) === true, "intake: a foreign-user click is still ours (handled)");
  ok(wrong.methods().includes("chat.postEphemeral") && !wrong.methods().includes("views.open"), "intake: wrong clicker gets an ephemeral notice and NO views.open (fail closed)");

  const right = recorder();
  ok((await intake.handleSetKeyClick(click(OWNER), { post: right.post, now: () => t0 })) === true, "intake: the requester's click is handled");
  ok(right.methods().includes("views.open"), "intake: the requester's click opens the modal (views.open)");

  const submit = (user: string, value: string) => ({
    type: "view_submission",
    user: { id: user },
    team: { id: "T1" },
    view: {
      callback_id: intake.OE_SETKEY_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ org: ORG, id, channelId: CH }),
      state: { values: { [intake.SETKEY_INPUT_BLOCK]: { [intake.SETKEY_INPUT_ACTION]: { value } } } },
    },
  });

  const future = new Date(t0.getTime() + intake.CREDENTIAL_INTAKE_TTL_MS + 1000);
  const exp = await intake.handleSetKeyViewSubmission(submit(OWNER, SENTINEL), { post: recorder().post, now: () => future });
  ok(exp.handled === true && !!exp.response && (exp.response as Record<string, unknown>).response_action === "errors", "intake: an expired submit returns an inline error");
  ok((await getOperationalStore().getCredentialIntake(ORG, id))?.usedAt === undefined, "intake: an expired submit does NOT consume the intake");

  const blank = await intake.handleSetKeyViewSubmission(submit(OWNER, "   "), { post: recorder().post, now: () => t0 });
  ok(blank.handled === true && !!blank.response, "intake: a blank value returns an inline error");
  ok((await getOperationalStore().getCredentialIntake(ORG, id))?.usedAt === undefined, "intake: a blank submit does NOT consume the intake");
}

{
  const OWNER = "U_OWNER";
  const CH = "C_KEYS2";
  const REF = "db:notion-eng-key-3";
  const t0 = new Date("2026-07-20T11:00:00Z");

  const rq = recorder();
  const { id } = await intake.requestCredentialIntake(
    { org: ORG, provider: "notion", domain: "eng", ref: REF, requestedBy: OWNER, channelId: CH, teamId: "T1" },
    { post: rq.post, now: () => t0, mintId: () => "intake-store" },
  );

  const submit = {
    type: "view_submission",
    user: { id: OWNER },
    team: { id: "T1" },
    view: {
      callback_id: intake.OE_SETKEY_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ org: ORG, id, channelId: CH }),
      state: { values: { [intake.SETKEY_INPUT_BLOCK]: { [intake.SETKEY_INPUT_ACTION]: { value: SENTINEL } } } },
    },
  };

  const logs: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));

  const sub = recorder();
  let res: Awaited<ReturnType<typeof intake.handleSetKeyViewSubmission>>;
  try {
    res = await intake.handleSetKeyViewSubmission(submit, { post: sub.post, now: () => t0 });
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }

  ok(res.handled === true && res.response === undefined, "store: a valid submit succeeds and closes the modal (empty response)");
  ok((await getSecretVia("db", REF)) === SENTINEL, "store: the value is retrievable through the broker (end-to-end store worked)");

  ok(!logs.some((l) => l.includes(SENTINEL)), "leak-proof: the secret value appears in NO captured console output");
  ok(!sub.calls.some((c) => c.body.includes(SENTINEL)), "leak-proof: the secret value appears in NO posted Slack body (confirmation names provider/domain only)");
  const auditRows = await readAudit({ org: ORG });
  ok(auditRows.some((r) => r.action === "credential.stored") && auditRows.some((r) => r.action === "credential.intake_requested"), "audit: credential.intake_requested + credential.stored rows exist");
  ok(!JSON.stringify(auditRows).includes(SENTINEL), "leak-proof: the secret value appears in NO audit row (not even its length)");
  const stored = await getOperationalStore().getStoredCredential(ORG, REF);
  ok(!!stored && !stored.ciphertext.includes(SENTINEL) && stored.provider === "notion" && stored.domain === "eng", "store: only ciphertext + labels are persisted, never the plaintext");

  const again = await intake.handleSetKeyViewSubmission(submit, { post: recorder().post, now: () => t0 });
  ok(again.handled === true && !!again.response && (again.response as Record<string, unknown>).response_action === "errors", "single-use: a second submit of the same intake is refused (CAS)");
}

{
  const grants = runtimeRoleGrantsSql("oe_runtime");
  const verbsFor = (table: string, kind: "GRANT" | "REVOKE"): Set<string> => {
    const found = new Set<string>();
    for (const stmt of grants) {
      const m = stmt.match(/^(GRANT|REVOKE) (.+?) ON (.+?) (?:TO|FROM) \w+$/);
      if (!m || m[1] !== kind) continue;
      if (!m[3].split(", ").includes(table)) continue;
      for (const v of m[2].split(", ")) found.add(v);
    }
    return found;
  };
  for (const table of ["stored_credential", "credential_intake"]) {
    const granted = verbsFor(table, "GRANT");
    ok(granted.has("SELECT") && granted.has("INSERT") && granted.has("UPDATE"), `runtime-role: ${table} is granted SELECT+INSERT+UPDATE (the broker upserts and then rotates/stamps)`);
  }
  ok(!verbsFor("credential_intake", "GRANT").has("DELETE") && verbsFor("credential_intake", "REVOKE").has("DELETE"), "runtime-role: credential_intake is NOT granted DELETE, and DELETE is explicitly revoked (tightens a role provisioned by an older build)");
  ok(verbsFor("stored_credential", "GRANT").has("DELETE"), "runtime-role: stored_credential IS granted DELETE (OPE-287 — a purge must be able to destroy the ciphertext, not merely unaddress it)");
  ok(!verbsFor("stored_credential", "REVOKE").has("DELETE"), "runtime-role: …and DELETE is not simultaneously revoked (a grant plus a revoke would leave the purge dead at the engine)");
}

{
  const { expandProviderGrant } = await import("../agent/access/providers.js");
  type ApiKeyProvider = Parameters<typeof expandProviderGrant>[1] & object;

  resetBrokers();
  dbBroker.registerDbCredentialBroker();

  const ENV_ONLY_REF = "OE_TEST_ENV_ONLY_SECRET";
  process.env[ENV_ONLY_REF] = "env-value-xyz";

  ok((await getSecretVia("env", ENV_ONLY_REF)) === "env-value-xyz", "stamp: getSecretVia('env', ref) reads the env broker");

  await assert.rejects(() => getSecretVia(undefined, ENV_ONLY_REF), (e) => e instanceof CredentialError && /no credential broker/.test((e as Error).message), "no default: getSecretVia(undefined, ref) rejects — there is no selected default (fail closed)");

  await dbBroker.storeDbSecret({ org: ORG, ref: "db:stamp-check", plaintext: "db-value", createdBy: "U" });
  ok((await getSecretVia("db", "db:stamp-check")) === "db-value", "stamp: getSecretVia('db', ref) reads the db store");

  ok(brokerFor("env") !== undefined && brokerFor("db") !== undefined, "brokerFor resolves registered brokers by name");
  assert.throws(() => brokerFor("nope"), (e) => e instanceof CredentialError && /not registered/.test((e as Error).message), "brokerFor('unregistered') throws (fail closed, no fallback)");
  await assert.rejects(() => getSecretVia("nope", ENV_ONLY_REF), (e) => e instanceof CredentialError && /not registered/.test((e as Error).message), "getSecretVia('unregistered', ...) fails closed");

  const providerStamped = { name: "p", connection: "c", allows: ["api-key"], credentials: [{ id: "k", type: "api-key", secretRef: ENV_ONLY_REF, broker: "env" }] } as ApiKeyProvider;
  const rStamped = expandProviderGrant({ provider: "p", credential: "k" }, providerStamped, { dm: false });
  ok(rStamped.resolved?.broker === "env" && rStamped.resolved?.secretRef === ENV_ONLY_REF, "expandProviderGrant carries the credential's home broker into the resolved binding");
  const providerUnstamped = { name: "p2", connection: "c", allows: ["api-key"], credentials: [{ id: "k", type: "api-key", secretRef: ENV_ONLY_REF }] } as ApiKeyProvider;
  const rUnstamped = expandProviderGrant({ provider: "p2", credential: "k" }, providerUnstamped, { dm: false });
  ok(rUnstamped.resolved?.broker === undefined, "an unstamped credential resolves with broker: undefined (validation rejects it at definition; runtime resolution would fail closed)");

  const stampedHeaders = await resolveHeaders({ id: "notion-rest", credentialType: "bearer", secretRef: ENV_ONLY_REF, broker: "env", allowedWebsites: ["api.notion.com"] });
  ok(stampedHeaders.authorization === "Bearer env-value-xyz", "resolveHeaders: a broker:'env'-stamped bearer connection injects the ENV value");
  await assert.rejects(() => resolveHeaders({ id: "unstamped", credentialType: "bearer", secretRef: ENV_ONLY_REF, allowedWebsites: ["api.notion.com"] }), (e) => e instanceof CredentialError && /no credential broker/.test((e as Error).message), "resolveHeaders: an UNSTAMPED bearer connection fails closed — there is no default broker");

  delete process.env[ENV_ONLY_REF];
}


console.log(`credential-broker-test: ${n} checks passed`);
