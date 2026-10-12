process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { registerOperationalStore, getOperationalStore } from "../agent/operational/provider.js";
import { confirmLinkedId, ensureLinkSet, suggestLinkedId } from "../agent/identity/link-store.js";
import { rawVaultSubject, sharedVaultSubject } from "../agent/identity/oauth-vault-share.js";
import { checkXaaIdentityBinding, recordXaaRefusal, OKTA_LINK_PLATFORM, XAA_LINK_REFUSED_ACTION } from "../agent/connections/xaa-identity-binding.js";
import { verifyOidcIdToken } from "../agent/connections/oidc-id-token.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ORG = "default";
const CONN = "mcp-server/datadog";
const ALICE_OKTA = "00uALICE0000000000";
const BOB_OKTA = "00uBOB000000000000";

const db = new PGlite();
const client: PgClient = { query: (text, params) => db.query(text, params ? [...params] : undefined) };
await initOperationalSchema(client);
registerOperationalStore(makeOperationalPostgresStore(client));

const evidence = { kind: "directory-sync", provider: "okta", grade: "attested" } as const;
async function link(linkSetId: string, platform: string, tenant: string, nativeId: string): Promise<void> {
  await suggestLinkedId({ org: ORG, linkSetId, account: { platform, tenant, nativeId }, evidence });
  await confirmLinkedId({ org: ORG, account: { platform, tenant, nativeId }, evidence });
}

await ensureLinkSet({ org: ORG, linkSetId: "set-alice", handle: "alice" });
await link("set-alice", "discord", "", "D_ALICE");
await link("set-alice", OKTA_LINK_PLATFORM, "", ALICE_OKTA);
await ensureLinkSet({ org: ORG, linkSetId: "set-carol", handle: "carol" });
await link("set-carol", "discord", "", "D_CAROL");
await ensureLinkSet({ org: ORG, linkSetId: "set-dave", handle: "dave" });
await link("set-dave", "discord", "", "D_DAVE");
await suggestLinkedId({ org: ORG, linkSetId: "set-dave", account: { platform: OKTA_LINK_PLATFORM, tenant: "", nativeId: BOB_OKTA }, evidence });

const aliceSubject = rawVaultSubject(ORG, "discord", "", "D_ALICE");
const refusalRows = () => getOperationalStore().readAudit({ org: ORG, action: XAA_LINK_REFUSED_ACTION, limit: 100 });
const bind = (principalSubject: string, signerSubject: string | undefined) => checkXaaIdentityBinding({ principalSubject, signerSubject, connection: CONN });

{
  const before = (await refusalRows()).length;
  const v = await bind(aliceSubject, ALICE_OKTA);
  ok(v.ok === true && v.idpNativeId === ALICE_OKTA, "match: a signer who IS the requester's confirmed Okta account is admitted");
  ok((await refusalRows()).length === before, "match: an admitted completion writes NO refusal row");
}

{
  const before = (await refusalRows()).length;
  const v = await bind(aliceSubject, BOB_OKTA);
  ok(v.ok === false && /different Okta account/u.test(v.reason), "🔴 mismatch: a DIFFERENT Okta account cannot complete Alice's link");
  const rows = await refusalRows();
  ok(rows.length === before + 1, "mismatch: the refusal writes exactly ONE audit row");
  const row = rows.find((r) => r.detail?.["signerSubject"] === BOB_OKTA);
  ok(row?.principalId === "D_ALICE" && row?.detail?.["connection"] === CONN, "mismatch: the row names the requester, the signer and the connection");
  ok(row?.detail?.["stage"] === "sign-in", "mismatch: the row says the refusal came at the sign-in");
  const atMint = await checkXaaIdentityBinding({ principalSubject: aliceSubject, signerSubject: BOB_OKTA, connection: CONN, stage: "mint" });
  ok(atMint.ok === false && /stored grant/u.test(atMint.reason), "mint stage: the reason names the stored grant, not a sign-in");
  ok((await refusalRows()).some((r) => r.detail?.["stage"] === "mint"), "mint stage: the row says the refusal came at a mint");
}

{
  const carol = await bind(rawVaultSubject(ORG, "discord", "", "D_CAROL"), BOB_OKTA);
  ok(carol.ok === false && /no linked Okta account/u.test(carol.reason), "no okta account: refused, never fallen back to the requester's subject");
  ok(carol.ok === false && carol.unreadable === undefined, "no okta account: a DEFINITE refusal carries no unreadable marker");
  const dave = await bind(rawVaultSubject(ORG, "discord", "", "D_DAVE"), BOB_OKTA);
  ok(dave.ok === false && /no linked Okta account/u.test(dave.reason), "suggested-only: an UNCONFIRMED okta row admits nobody");
  const stranger = await bind(rawVaultSubject(ORG, "discord", "", "D_NOBODY"), ALICE_OKTA);
  ok(stranger.ok === false && /no confirmed identity link/u.test(stranger.reason), "no link-set: refused");
}

{
  const v = await bind(sharedVaultSubject(ORG, "set-alice"), ALICE_OKTA);
  ok(v.ok === true, "shared subject: Alice's own set admits her own confirmed Okta account");
  const w = await bind(sharedVaultSubject(ORG, "set-alice"), BOB_OKTA);
  ok(w.ok === false, "🔴 shared subject: another Okta account is refused on Alice's set too");
  const carol = await bind(sharedVaultSubject(ORG, "set-carol"), ALICE_OKTA);
  ok(carol.ok === false, "shared subject: Carol's set does not admit Alice's Okta account");
}

{
  ok((await bind("D_ALICE", ALICE_OKTA)).ok === false, "malformed subject: a bare native id is refused");
  const before = (await refusalRows()).length;
  const v = await bind(aliceSubject, undefined);
  ok(v.ok === false && /named no signer/u.test(v.reason), "unnameable signer: refused");
  ok((await refusalRows()).length === before + 1, "unnameable signer: the refusal is audited");
}

{
  const before = (await refusalRows()).length;
  await recordXaaRefusal({ principalSubject: aliceSubject, connection: CONN, reason: "the IdP id token did not verify" });
  const rows = await refusalRows();
  ok(rows.length === before + 1 && rows.some((r) => r.detail?.["reason"] === "the IdP id token did not verify" && r.principalId === "D_ALICE"), "pre-binding refusal: one audit row for the requester");
  await recordXaaRefusal({ principalSubject: "D_ALICE", connection: CONN, reason: "x" });
  ok((await refusalRows()).length === before + 1, "pre-binding refusal: an unreadable subject writes nothing (no org to file it under)");
}

{
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", alg: "RS256", use: "sig" };
  const jwks = { keys: [jwk] } as Parameters<typeof verifyOidcIdToken>[1]["jwks"];
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signWith = (key: ReturnType<typeof createPrivateKey>, claims: Record<string, unknown>) => {
    const head = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64(claims)}`;
    return `${head}.${sign("sha256", Buffer.from(head), key).toString("base64url")}`;
  };
  const ISS = "https://acme.okta.com";
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: ISS, aud: "OE-CID", sub: ALICE_OKTA, nonce: "N1", iat: now, exp: now + 300 };
  const opts = { jwks, issuer: ISS, audience: "OE-CID", nonce: "N1" };
  ok((await verifyOidcIdToken(signWith(privateKey, good), opts)).sub === ALICE_OKTA, "id token: NEGATIVE CONTROL — a well-formed token verifies and names its sub");
  const refuses = async (token: string, label: string) => {
    let msg = "";
    try {
      await verifyOidcIdToken(token, opts);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    ok(/did not verify|names no subject/u.test(msg), label);
  };
  await refuses(signWith(other.privateKey, good), "🔴 id token: a token signed by ANOTHER key is refused");
  await refuses(signWith(privateKey, { ...good, nonce: "N2" }), "id token: a token from another sign-in (nonce) is refused");
  await refuses(signWith(privateKey, { ...good, aud: "SOMEONE-ELSE" }), "id token: a token for another client (aud) is refused");
  await refuses(signWith(privateKey, { ...good, iss: "https://evil.example" }), "id token: a token from another issuer is refused");
  await refuses(signWith(privateKey, { ...good, exp: now - 600 }), "id token: an expired token is refused");
}

{
  ok((await bind(aliceSubject, ALICE_OKTA)).ok === true, "store outage: NEGATIVE CONTROL — admitted while the store answers");
  await db.close();
  const v = await bind(aliceSubject, ALICE_OKTA);
  ok(v.ok === false && /could not be read/u.test(v.reason), "store outage: an unreadable link plane REFUSES, never throws");
  ok(v.ok === false && v.unreadable === true, "store outage: the refusal is marked unreadable, so a mint keeps the grant");
  const control = await bind(rawVaultSubject(ORG, "discord", "", "D_NOBODY"), ALICE_OKTA);
  ok(control.ok === false && control.unreadable === true, "store outage: every read failure carries the marker");
}

console.log(`✓ xaa-identity-binding: ${passed} assertions passed`);
process.exit(0);
