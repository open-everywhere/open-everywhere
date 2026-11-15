// proves: identity.credential.orphan_purged

import assert from "node:assert/strict";

import { rawVaultSubject, RAW_VAULT_SUBJECT_PREFIX, sharedVaultSubject } from "../agent/identity/oauth-vault-share.js";
import { classifyVaultRef, orphanSweepHolders, sweepOrphanedVaultRows } from "./purge-orphaned-vault-rows-lib.js";
import type { AuditInput } from "../agent/operational/store.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ORG = "default";
const TEAM = "T0AB1CD2E";

const oauthRef = (subject: string, provider = "notion") => `oe-oauth:tok:${provider}:user:${subject}`;
const ssoRef = (subject: string) => `aws-sso:tok:${subject}`;

const oldSubject = (platform: string, nativeId: string, org = ORG) => `${RAW_VAULT_SUBJECT_PREFIX}${org}/${platform}/${nativeId}`;

{
  for (const [ref, holder] of [
    [oauthRef(oldSubject("slack", "U0EXOWNER")), "oe-oauth"],
    [ssoRef(oldSubject("slack", "U0EXOWNER")), "aws-sso"],
  ] as const) {
    const v = classifyVaultRef(ref, ORG);
    ok(v.kind === "orphan", `🔴 the pre-OPE-309 two-segment slack subject IS an orphan (${holder})`);
    ok(v.kind === "orphan" && v.holder === holder && v.platform === "slack" && v.nativeId === "U0EXOWNER" && v.org === ORG, `${holder}: the verdict carries the holder, org, platform and native id the audit row needs`);
  }

  const current = rawVaultSubject(ORG, "slack", TEAM, "U0EXOWNER");
  ok(current === `${RAW_VAULT_SUBJECT_PREFIX}${ORG}/slack/${TEAM}/U0EXOWNER`, "the post-phase-1 subject carries the workspace rung (pins the shape this test is about)");
  ok(classifyVaultRef(oauthRef(current), ORG).kind === "current", "🔴 the CURRENT three-segment slack key is never a candidate — it is composable today, so something still resolves it");
  ok(classifyVaultRef(ssoRef(current), ORG).kind === "current", "…on the aws-sso holder too");

  for (const platform of ["discord", "github", "linear", "notion", "teams"]) {
    const live = rawVaultSubject(ORG, platform, undefined, "ID-123");
    ok(live === oldSubject(platform, "ID-123"), `${platform}: its CURRENT subject is byte-identical in shape to a slack orphan (the trap this test exists for)`);
    ok(classifyVaultRef(oauthRef(live), ORG).kind === "current", `🔴 ${platform}: a live vendor-global row is NOT swept — a segment count would have destroyed it`);
  }

  ok(classifyVaultRef(oauthRef(sharedVaultSubject(ORG, "ls-7f3c")), ORG).kind === "current", "a shared `ls:` link-set subject is left alone");

  const skips: readonly (readonly [string, string])[] = [
    [oauthRef("U0EXOWNER"), "an unqualified pre-OPE-286 bare native id (no `p:` prefix — no org, no platform to check)"],
    [ssoRef("U0EXOWNER"), "the same, on the aws-sso holder — the OPE-286 residue is a DIFFERENT orphan class and out of scope"],
    [oauthRef(`${RAW_VAULT_SUBJECT_PREFIX}${ORG}/slack/dev/U1`), 'the refused UNNAMED_TENANT ("dev") rung — well-shaped, composable by nobody'],
    [oauthRef(`${RAW_VAULT_SUBJECT_PREFIX}${ORG}/slack/a/b/c/U1`), "too many segments to be either grammar"],
    [oauthRef(`${RAW_VAULT_SUBJECT_PREFIX}${ORG}/slack/`), "an empty native id"],
    [oauthRef(`${RAW_VAULT_SUBJECT_PREFIX}${ORG}/slack`), "no principal key at all — just an org"],
    [oauthRef(`${RAW_VAULT_SUBJECT_PREFIX}otherOrg/slack/U1`), "🔴 an orphan-SHAPED subject whose own org segment is not the org being swept"],
    [oauthRef(oldSubject("slack", "U1"), "weird:user:provider"), "🔴 a ref whose `:user:` marker appears twice — the subject cannot be split out unambiguously"],
  ];
  for (const [ref, why] of skips) {
    const v = classifyVaultRef(ref, ORG);
    ok(v.kind === "skip", `skipped, not deleted: ${why}`);
    ok(v.kind === "skip" && v.reason.length > 0, `…and the skip states its reason (an operator has to be able to see the row): ${why}`);
  }

  for (const ref of ["db:notion-eng-key", "oe-oauth:dcr:notion", "oe-oauth:pend:abc123", "oe-oauth:tok:notion:app", "whsec:something"]) {
    ok(classifyVaultRef(ref, ORG).kind === "not-subject-keyed", `not person-keyed, never inspected further: ${ref}`);
  }

  ok(orphanSweepHolders().join(",") === "oe-oauth,aws-sso", "the holder enumeration is exactly the two adapters that key a ref by a per-person subject");
}

function stubStore(refs: readonly string[]) {
  const rows = new Set(refs);
  const deleteCalls: string[] = [];
  return {
    deleteCalls,
    rows,
    store: {
      async listStoredCredentialRefs(org: string) {
        return org === ORG ? [...rows].sort() : [];
      },
      async deleteStoredCredential(org: string, ref: string) {
        deleteCalls.push(ref);
        return org === ORG && rows.delete(ref);
      },
    },
  };
}

const FIXTURE = [
  oauthRef(oldSubject("slack", "U_ORPHAN_A")),
  ssoRef(oldSubject("slack", "U_ORPHAN_B")),
  oauthRef(rawVaultSubject(ORG, "slack", TEAM, "U_LIVE")),
  oauthRef(rawVaultSubject(ORG, "discord", undefined, "9876543210")),
  oauthRef(sharedVaultSubject(ORG, "ls-7f3c")),
  oauthRef("U_BARE"),
  "db:notion-eng-key",
  "oe-oauth:dcr:notion",
];

{
  const { store, rows, deleteCalls } = stubStore(FIXTURE);
  const audits: AuditInput[] = [];
  const r = await sweepOrphanedVaultRows({ store, org: ORG, actor: "op", audit: async (e) => void audits.push(e) });
  ok(r.scanned === FIXTURE.length, "dry run: every ref in the org was scanned");
  ok(r.matched === 2, "dry run: both orphans matched");
  ok(r.deleted === 0 && deleteCalls.length === 0, "🔴 dry run: the delete verb was never CALLED — the default mode is not merely quiet, it is inert");
  ok(audits.length === 0, "🔴 dry run: no audit row either — an audit row asserts something HAPPENED");
  ok(rows.size === FIXTURE.length, "dry run: the store is untouched");
  ok(r.skipped === 1 && r.current === 3 && r.notSubjectKeyed === 2, "dry run: the other verdicts are counted, not lumped in with the matches");
  ok(r.scanned === r.matched + r.skipped + r.current + r.notSubjectKeyed, "🔴 the totals RECONCILE — every scanned row lands in exactly one bucket, so nothing can vanish between the enumeration and the report");
  ok(r.byHolder["oe-oauth"]?.matched === 1 && r.byHolder["aws-sso"]?.matched === 1, "dry run: matches are broken down per holder — an operator needs to know WHICH credential class the residue is in");
}

{
  const { store, rows, deleteCalls } = stubStore(FIXTURE);
  const audits: AuditInput[] = [];
  const r = await sweepOrphanedVaultRows({ store, org: ORG, apply: true, actor: "op", audit: async (e) => void audits.push(e) });
  ok(r.matched === 2 && r.deleted === 2, "apply: both orphans were destroyed");
  ok(deleteCalls.length === 2, "apply: exactly two deletes were attempted — the sweep does not touch a row it did not match");
  ok(rows.size === FIXTURE.length - 2, "apply: the store lost exactly the two orphan rows");
  ok(!rows.has(oauthRef(oldSubject("slack", "U_ORPHAN_A"))) && !rows.has(ssoRef(oldSubject("slack", "U_ORPHAN_B"))), "apply: …and it lost the RIGHT two");
  ok(rows.has(oauthRef(rawVaultSubject(ORG, "discord", undefined, "9876543210"))), "🔴 apply: the live discord row — same shape as an orphan — is still there");
  ok(rows.has(oauthRef(rawVaultSubject(ORG, "slack", TEAM, "U_LIVE"))), "apply: so is the re-consented slack row");
  ok(rows.has(oauthRef("U_BARE")), "apply: and so is the skipped one — a skip means LEFT IN PLACE, not quietly handled");

  ok(audits.length === 2, "apply: one audit row per deletion");
  ok(audits.every((a) => a.action === "identity.credential.orphan_purged"), "apply: on a stable dotted action key");
  ok(audits.every((a) => a.org === ORG && a.principalId === "op" && a.platform === "slack"), "apply: stamped with the org, the operator and the platform whose rows moved");
  ok(audits.every((a) => typeof a.detail?.ref === "string" && typeof a.detail?.subject === "string" && typeof a.detail?.holder === "string"), "apply: the detail names the ref, the subject and the holder — the keys, which is all this path ever reads");
  ok(!audits.some((a) => JSON.stringify(a.detail).includes("ciphertext")), "🔴 apply: no ciphertext anywhere near the audit row — the enumeration returns refs only and the delete needs nothing more");

  const again = await sweepOrphanedVaultRows({ store, org: ORG, apply: true, actor: "op", audit: async (e) => void audits.push(e) });
  ok(again.matched === 0 && again.deleted === 0, "🔴 apply is IDEMPOTENT — a re-run is a no-op, so an interrupted sweep is safe to repeat");
  ok(audits.length === 2, "…and writes no second audit row: the record says what HAPPENED, not what was attempted");
}

{
  const { store } = stubStore([oauthRef(oldSubject("slack", "U_RACED"))]);
  const racing = { ...store, deleteStoredCredential: async () => false };
  const audits: AuditInput[] = [];
  const r = await sweepOrphanedVaultRows({ store: racing, org: ORG, apply: true, actor: "op", audit: async (e) => void audits.push(e) });
  ok(r.matched === 1 && r.deleted === 0, "a row that had already gone counts as matched, never as deleted");
  ok(audits.length === 0, "…and writes no audit row for a deletion that did not happen");
}

{
  const { store } = stubStore([oauthRef(oldSubject("slack", "U_BOOM"))]);
  const broken = { ...store, deleteStoredCredential: async () => { throw new Error("store down"); } };
  let threw = false;
  try {
    await sweepOrphanedVaultRows({ store: broken, org: ORG, apply: true, actor: "op", audit: async () => {} });
  } catch {
    threw = true;
  }
  ok(threw, "🔴 a store failure during --apply is FAIL-LOUD — a partial sweep that under-reported what it destroyed is the worst possible output");
}

console.log(`✓ orphaned-vault-purge: ${n} assertions (the fail-closed subject matcher on both holders, the vendor-global look-alike, the ambiguous skips, dry-run inertness, per-deletion audit, idempotence, fail-loud)`);
