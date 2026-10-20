// proves: AP-MOD-core-credentials-self-secrets

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

const dir = join(tmpdir(), `oe-self-secrets-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { getOrMintSelfSecret, selfSecretsArmed, resetSelfSecretCache } = await import("../agent/credentials/self-secrets.js");
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
  ok(selfSecretsArmed(), "armed: OE_CREDENTIAL_ENCRYPTION_KEY is set");

  eq(await vault.read("self:OE_TEST_MINT_A"), null, "precondition: nothing stored yet under this ref");
  const minted = await getOrMintSelfSecret("OE_TEST_MINT_A");
  ok(typeof minted === "string" && minted.length >= 32, "mint: returns a high-entropy value");
  const storedAfterMint = await vault.read("self:OE_TEST_MINT_A");
  eq(storedAfterMint, minted, "mint: the minted value is durably stored under self:<name>");

  const second = await getOrMintSelfSecret("OE_TEST_MINT_A");
  eq(second, minted, "mint is idempotent: a second call converges on the SAME stored value, not a fresh mint");

  process.env.OE_TEST_MINT_B = "env-value-that-0.9.0-ignores";
  const notFromEnv = await getOrMintSelfSecret("OE_TEST_MINT_B");
  ok(notFromEnv !== "env-value-that-0.9.0-ignores" && notFromEnv.length >= 32, "no env arm: an env var of the same name is not read — the resolver mints instead");
  eq(await vault.read("self:OE_TEST_MINT_B"), notFromEnv, "…and the vault holds the MINT, not the env value");
  delete process.env.OE_TEST_MINT_B;

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

console.log("6. memoisation (a vault READ, not a fresh mint, is what gets memoised — OPE-480):");
{
  resetSelfSecretCache();
  const first = await getOrMintSelfSecret("OE_TEST_MINT_CACHE");
  eq(await vault.read("self:OE_TEST_MINT_CACHE"), first, "precondition: the mint landed in the vault");
  const primed = await getOrMintSelfSecret("OE_TEST_MINT_CACHE");
  eq(primed, first, "the priming call converges on the same value the mint just wrote (a READ, now memoised)");

  await vault.write("self:OE_TEST_MINT_CACHE", "mutated-behind-the-cache");

  const third = await getOrMintSelfSecret("OE_TEST_MINT_CACHE");
  eq(third, first, "memoised: a call after a READ has been cached returns the CACHED value, not the value now stored in the vault");

  resetSelfSecretCache();
  const fourth = await getOrMintSelfSecret("OE_TEST_MINT_CACHE");
  eq(fourth, "mutated-behind-the-cache", "resetSelfSecretCache() clears the cache: the next call reads the vault fresh");

  const counting = { calls: 0, inner: vault };
  const countingVault = {
    ...vault,
    read: async (ref: string) => {
      counting.calls++;
      return counting.inner.read(ref);
    },
  };
  await vault.write("self:OE_TEST_MINT_CACHE", "value-for-injected-vault-path");
  const viaInjected = await getOrMintSelfSecret("OE_TEST_MINT_CACHE", { vault: countingVault });
  eq(viaInjected, "value-for-injected-vault-path", "an injected deps.vault bypasses the cache — reads the vault fresh even though the default path has this name cached");
  ok(counting.calls > 0, "…and genuinely called the injected vault's read (not a coincidental cache hit)");
}

console.log("7. mint race self-heals (OPE-480):");
{
  resetSelfSecretCache();
  eq(await vault.read("self:OE_TEST_RACE"), null, "precondition: nothing stored yet under this ref");

  const ownMint = await getOrMintSelfSecret("OE_TEST_RACE");
  eq(await vault.read("self:OE_TEST_RACE"), ownMint, "the mint landed in the vault as this process's own value");

  await vault.write("self:OE_TEST_RACE", "racer-won-the-last-write");

  const healed = await getOrMintSelfSecret("OE_TEST_RACE");
  eq(healed, "racer-won-the-last-write", "mint race self-heals: the call after a fresh mint re-reads the vault and converges on the winner, not the stale local mint");
  ok(healed !== ownMint, "…concretely: the healed value differs from this process's own (now-superseded) mint");

  await vault.write("self:OE_TEST_RACE", "should-not-be-observed-yet");
  const stillHealed = await getOrMintSelfSecret("OE_TEST_RACE");
  eq(stillHealed, "racer-won-the-last-write", "the converged value is memoised normally — a READ result IS cached, only a fresh MINT is not");
}

console.log(`✓ self-secrets: ${n} assertions passed (resolution order, mint durability + convergence, fail-closed, reserved namespace, memoisation, mint-race self-heal)`);
