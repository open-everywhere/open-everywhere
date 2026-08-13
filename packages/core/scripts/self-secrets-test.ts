import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const dir = join(tmpdir(), `oe-self-secrets-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { getOrMintSelfSecret, selfSecretsArmed, resetSelfSecretWarnings } = await import("../agent/credentials/self-secrets.js");
const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
const { getSecretVia } = await import("../agent/access/credentials.js");
const { registerDbCredentialBroker } = await import("../agent/credentials/db-broker.js");
registerDbCredentialBroker();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const vault = encryptedKvVault();

console.log("1+2+3. resolution order, mint durability, distinct names:");
{
  resetSelfSecretWarnings();
  ok(selfSecretsArmed(), "armed: OE_CREDENTIAL_ENCRYPTION_KEY is set");

  eq(await vault.read("self:OE_TEST_MINT_A"), null, "precondition: nothing stored yet under this ref");
  const minted = await getOrMintSelfSecret("OE_TEST_MINT_A");
  ok(typeof minted === "string" && minted.length >= 32, "mint: returns a high-entropy value");
  const storedAfterMint = await vault.read("self:OE_TEST_MINT_A");
  eq(storedAfterMint, minted, "mint: the minted value is durably stored under self:<name>");

  const second = await getOrMintSelfSecret("OE_TEST_MINT_A");
  eq(second, minted, "mint is idempotent: a second call converges on the SAME stored value, not a fresh mint");

  process.env.OE_TEST_MINT_B = "env-on-ramp-value-for-B";
  const fromEnv = await getOrMintSelfSecret("OE_TEST_MINT_B");
  eq(fromEnv, "env-on-ramp-value-for-B", "env on-ramp: an unset-in-vault name with an env var present resolves from env");
  eq(await vault.read("self:OE_TEST_MINT_B"), null, "…and the env value is NOT auto-promoted into the vault");

  await vault.write("self:OE_TEST_MINT_C", "stored-wins-value");
  process.env.OE_TEST_MINT_C = "env-value-that-should-be-ignored";
  const stored = await getOrMintSelfSecret("OE_TEST_MINT_C");
  eq(stored, "stored-wins-value", "resolution order: a stored row wins over an env var of the same name");
  delete process.env.OE_TEST_MINT_C;

  const mintedD = await getOrMintSelfSecret("OE_TEST_MINT_D");
  ok(mintedD !== minted, "distinct names mint distinct values (A and D never collide)");
  eq(await vault.read("self:OE_TEST_MINT_D"), mintedD, "…each stored under its own self:<name> ref");
}

console.log("4. fail closed:");
{
  const saved = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  ok(!selfSecretsArmed(), "unarmed: selfSecretsArmed() is false with no encryption key");
  let threw = "";
  try {
    await getOrMintSelfSecret("OE_TEST_MINT_UNARMED");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  ok(/OE_CREDENTIAL_ENCRYPTION_KEY/.test(threw), `throws naming the missing key (got: ${threw})`);
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = saved;
  eq(await vault.read("self:OE_TEST_MINT_UNARMED"), null, "…and nothing was minted: re-armed, a read finds no row for this ref at all");
}

console.log("5. the self: namespace is refused by the outbound resolver:");
{
  const minted = await getOrMintSelfSecret("OE_TEST_MINT_E");
  let threw = "";
  try {
    await getSecretVia("db", "self:OE_TEST_MINT_E");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  ok(/reserved/i.test(threw) && /self:/.test(threw), `the db broker refuses to resolve a self: ref as an outbound credential (got: ${threw})`);
  ok(minted.length > 0, "…even though the value genuinely exists (the refusal is about the NAMESPACE, not a missing row)");
}

console.log(`✓ self-secrets: ${n} assertions passed (resolution order, mint durability + convergence, fail-closed, reserved namespace)`);
