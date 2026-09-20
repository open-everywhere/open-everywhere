process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { registerOperationalStore, getOperationalStore } from "../agent/operational/provider.js";
import { confirmLinkedId, ensureLinkSet, suggestLinkedId } from "../agent/identity/link-store.js";
import { rawVaultSubject, sharedVaultSubject } from "../agent/identity/oauth-vault-share.js";
import { checkAwsSsoIdentityBinding, AWS_SSO_LINK_PLATFORM } from "../agent/connections/aws-sso-identity-binding.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ORG = "default";
const ALICE_AWS_SUB = "94482408-0011-7098-abcd-1e4f2c9b0000";
const BOB_AWS_SUB = "94482408-0011-7098-abcd-1e4f2c9b1111";

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
await link("set-alice", AWS_SSO_LINK_PLATFORM, "", ALICE_AWS_SUB);

await ensureLinkSet({ org: ORG, linkSetId: "set-carol", handle: "carol" });
await link("set-carol", "discord", "", "D_CAROL");

await ensureLinkSet({ org: ORG, linkSetId: "set-dave", handle: "dave" });
await link("set-dave", "discord", "", "D_DAVE");
await suggestLinkedId({ org: ORG, linkSetId: "set-dave", account: { platform: AWS_SSO_LINK_PLATFORM, tenant: "", nativeId: BOB_AWS_SUB }, evidence });

const aliceSubject = rawVaultSubject(ORG, "discord", "", "D_ALICE");
const carolSubject = rawVaultSubject(ORG, "discord", "", "D_CAROL");
const daveSubject = rawVaultSubject(ORG, "discord", "", "D_DAVE");
const strangerSubject = rawVaultSubject(ORG, "discord", "", "D_NOBODY");

async function refusalRows(): Promise<readonly { readonly principalId?: string; readonly detail?: Readonly<Record<string, unknown>> }[]> {
  const rows = await getOperationalStore().readAudit({ org: ORG, action: "aws.sso.link_refused", limit: 100 });
  return rows;
}

{
  const before = (await refusalRows()).length;
  const verdict = await checkAwsSsoIdentityBinding({ principalSubject: aliceSubject, signerSubject: ALICE_AWS_SUB });
  ok(verdict.ok === true, "match: a signer who IS the requester's confirmed Identity Center account is admitted");
  ok(verdict.ok === true && verdict.awsNativeId === ALICE_AWS_SUB, "match: the verdict names the linked account it matched");
  ok((await refusalRows()).length === before, "match: an admitted completion writes NO refusal row");
}

{
  const before = (await refusalRows()).length;
  const verdict = await checkAwsSsoIdentityBinding({ principalSubject: aliceSubject, signerSubject: BOB_AWS_SUB });
  ok(verdict.ok === false, "mismatch: a DIFFERENT Identity Center account is refused (the forwarded link)");
  ok(verdict.ok === false && /different Identity Center account/u.test(verdict.reason), "mismatch: the refusal says which axis failed");
  const rows = await refusalRows();
  ok(rows.length === before + 1, "mismatch: the refusal writes exactly ONE audit row");
  const row = rows.find((r) => r.detail?.signerSubject === BOB_AWS_SUB);
  ok(row !== undefined, "mismatch: the audit row names the SIGNER who opened the link that was not theirs");
  ok(row?.principalId === "D_ALICE", "mismatch: the audit row's actor is the REQUESTER whose link was spent");
}

{
  const before = (await refusalRows()).length;
  const verdict = await checkAwsSsoIdentityBinding({ principalSubject: carolSubject, signerSubject: BOB_AWS_SUB });
  ok(verdict.ok === false, "no linked aws account: refused, NEVER fallen back to the requester's own subject");
  ok(verdict.ok === false && /no linked AWS Identity Center account/u.test(verdict.reason), "no linked aws account: the refusal names the missing link");
  ok((await refusalRows()).length === before + 1, "no linked aws account: the refusal is audited");
}

{
  const verdict = await checkAwsSsoIdentityBinding({ principalSubject: daveSubject, signerSubject: BOB_AWS_SUB });
  ok(verdict.ok === false, "suggested-only: an UNCONFIRMED aws row admits nobody — only the person's own proof counts");
  ok(
    verdict.ok === false && /no linked AWS Identity Center account/u.test(verdict.reason),
    "suggested-only: the suggestion is invisible to the join, so it reads as no linked account at all",
  );
}

{
  const before = (await refusalRows()).length;
  const verdict = await checkAwsSsoIdentityBinding({ principalSubject: strangerSubject, signerSubject: ALICE_AWS_SUB });
  ok(verdict.ok === false, "no link-set: a requester the plane holds nothing for is refused");
  ok(verdict.ok === false && /no confirmed identity link/u.test(verdict.reason), "no link-set: the refusal names the missing link-set");
  ok((await refusalRows()).length === before + 1, "no link-set: the refusal is audited");
}

{
  const verdict = await checkAwsSsoIdentityBinding({ principalSubject: sharedVaultSubject(ORG, "set-alice"), signerSubject: ALICE_AWS_SUB });
  ok(verdict.ok === false, "shared subject: an `ls:` subject names a SET, so the signer cannot be attributed — refused");
}

{
  const verdict = await checkAwsSsoIdentityBinding({ principalSubject: "D_ALICE", signerSubject: ALICE_AWS_SUB });
  ok(verdict.ok === false, "malformed subject: a bare native id is not a vault subject — refused");
}

{
  const before = (await refusalRows()).length;
  const verdict = await checkAwsSsoIdentityBinding({ principalSubject: aliceSubject, signerSubject: undefined });
  ok(verdict.ok === false, "unnameable signer: a completion that names nobody is refused");
  ok(verdict.ok === false && /named no signer/u.test(verdict.reason), "unnameable signer: the refusal names the axis that failed");
  const rows = await refusalRows();
  ok(rows.length === before + 1, "🔴 unnameable signer: the refusal IS AUDITED — one row, like every other refusal");
  const row = rows.find((r) => r.detail?.reason === "the AWS sign-in named no signer");
  ok(row?.detail?.signerSubject === null, "unnameable signer: the row records that no signer was named, rather than omitting the key");
  ok(row?.principalId === "D_ALICE", "unnameable signer: the row's actor is the requester whose link was spent");
}

{
  const control = await checkAwsSsoIdentityBinding({ principalSubject: aliceSubject, signerSubject: ALICE_AWS_SUB });
  ok(control.ok === true, "store outage: NEGATIVE CONTROL — the same call is admitted while the store answers");

  await db.close();

  const verdict = await checkAwsSsoIdentityBinding({ principalSubject: aliceSubject, signerSubject: ALICE_AWS_SUB });
  ok(verdict.ok === false, "store outage: an unreadable identity-link plane REFUSES — it never throws past the caller");
  ok(
    verdict.ok === false && /could not be read/u.test(verdict.reason),
    "store outage: the refusal names the outage rather than claiming the accounts disagree",
  );
}

console.log(`✓ aws-sso-identity-binding: ${passed} assertions passed`);
process.exit(0);
