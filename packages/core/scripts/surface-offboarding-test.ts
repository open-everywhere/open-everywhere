import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-surface-offboarding-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { offboardDeactivatedAccount, OFFBOARD_REFUSAL, OFFBOARD_APPLIED_ACTION, OFFBOARD_REFUSED_ACTION } = await import("../agent/identity/offboarding.js");
const { ensureLinkSet, suggestLinkedId, confirmLinkedId } = await import("../agent/identity/link-store.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { registerCredentialPurgeHook } = await import("../agent/credentials/purge.js");
const { rawVaultSubject, sharedVaultSubject } = await import("../agent/identity/oauth-vault-share.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");

type DeactivationReport = import("../agent/identity/offboarding.js").DeactivationReport;

const ORG = "acme";
const OUR = "T0ACME";
const PARTNER = "T0PARTNER";
const STRANGER = "T0STRANGER";

let domains = [defineDomain({ name: "eng", reach: [`slack/${OUR}/C0ENG`] }), defineDomain({ name: "partner", reach: [`slack/${PARTNER}/C0SHARED`] })];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const purged: string[] = [];
registerCredentialPurgeHook("test-holder", {
  purgeSubject: async (subjectId: string) => {
    if (subjectId.includes("U0FAIL")) throw new Error("vault unreachable");
    purged.push(subjectId);
    return 1;
  },
});

async function personWith(linkSetId: string, accounts: readonly { platform: string; tenant: string; nativeId: string }[], confirm = true): Promise<void> {
  await ensureLinkSet({ org: ORG, linkSetId, handle: linkSetId });
  for (const account of accounts) {
    const s = await suggestLinkedId({ org: ORG, linkSetId, account, evidence: { kind: "config-import", note: "test" } });
    ok(s.ok, `fixture: ${account.nativeId} suggested onto ${linkSetId}`);
    if (confirm) {
      const c = await confirmLinkedId({ org: ORG, account, evidence: { kind: "config-import", note: "test" } });
      ok(c.ok, `fixture: ${account.nativeId} confirmed on ${linkSetId}`);
    }
  }
}

let confirmCalls = 0;
function report(over: Partial<DeactivationReport> & Pick<DeactivationReport, "nativeId">): DeactivationReport {
  return {
    org: ORG,
    platform: "slack",
    deliveringTenant: OUR,
    tenant: OUR,
    source: "slack:user_change",
    confirm: async () => {
      confirmCalls++;
      return { deactivated: true };
    },
    ...over,
  };
}

async function setStatus(linkSetId: string): Promise<string | undefined> {
  return (await getOperationalStore().getLinkSet(ORG, linkSetId))?.status;
}

async function lastRow(action: string, nativeId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await readAudit({ org: ORG, action, limit: 200 });
  const row = rows.find((r) => String((r.detail as { account?: unknown } | undefined)?.account ?? "").endsWith(`/${nativeId}`));
  return row?.detail as Record<string, unknown> | undefined;
}

{
  console.log("1. a confirmed deactivation revokes the link-set and purges its credentials:");
  await personWith("ls-hazel", [
    { platform: "slack", tenant: OUR, nativeId: "U0HAZEL" },
    { platform: "discord", tenant: "", nativeId: "300000000000000104" },
  ]);
  ok((await setStatus("ls-hazel")) === "active", "precondition: the set is active");
  purged.length = 0;
  const outcome = await offboardDeactivatedAccount(report({ nativeId: "U0HAZEL" }));
  ok(outcome.kind === "revoked", `outcome is revoked (got ${JSON.stringify(outcome)})`);
  ok((await setStatus("ls-hazel")) === "revoked", "🔴 the link-set is REVOKED");
  const ids = await getOperationalStore().listLinkedIds(ORG, "ls-hazel");
  ok(ids.length === 2 && ids.every((r) => r.status === "revoked"), "every account on the set is tombstoned, the other surface's account included");
  ok(purged.includes(sharedVaultSubject(ORG, "ls-hazel")), "🔴 the set's shared credential subject is purged");
  ok(purged.includes(rawVaultSubject(ORG, "slack", OUR, "U0HAZEL")), "…and the deactivated account's own subject");
  const applied = await lastRow(OFFBOARD_APPLIED_ACTION, "U0HAZEL");
  ok(applied?.["outcome"] === "revoked" && applied?.["linkSetId"] === "ls-hazel" && applied?.["source"] === "slack:user_change", "an identity.offboard.applied row records the revoke and its source");
  const revokedRows = await readAudit({ org: ORG, action: "identity.link.revoked", limit: 50 });
  ok(revokedRows.some((r) => (r.detail as { linkSetId?: string } | undefined)?.linkSetId === "ls-hazel"), "the lever's own identity.link.revoked row is written too");
}

{
  console.log("2. a report about an account in ANOTHER workspace revokes nothing:");
  await personWith("ls-ivy", [
    { platform: "slack", tenant: OUR, nativeId: "U0IVY" },
    { platform: "slack", tenant: PARTNER, nativeId: "U0IVYPARTNER" },
  ]);
  confirmCalls = 0;
  const outcome = await offboardDeactivatedAccount(report({ tenant: PARTNER, nativeId: "U0IVYPARTNER" }));
  ok(outcome.kind === "refused" && outcome.reason === OFFBOARD_REFUSAL.externalWorkspace, `refused as external-workspace (got ${JSON.stringify(outcome)})`);
  ok((await setStatus("ls-ivy")) === "active", "🔴 the internal person's set is still ACTIVE");
  ok(confirmCalls === 0, "the confirmation is never even asked for");
  ok((await lastRow(OFFBOARD_REFUSED_ACTION, "U0IVYPARTNER"))?.["reason"] === OFFBOARD_REFUSAL.externalWorkspace, "an identity.offboard.refused row names the reason");
}

{
  console.log("2b. a partner workspace's own deactivation does not revoke a set that also holds ours:");
  purged.length = 0;
  const outcome = await offboardDeactivatedAccount(report({ deliveringTenant: PARTNER, tenant: PARTNER, nativeId: "U0IVYPARTNER" }));
  ok(outcome.kind === "refused" && outcome.reason === OFFBOARD_REFUSAL.crossWorkspaceSet, `refused as cross-workspace-set (got ${JSON.stringify(outcome)})`);
  ok((await setStatus("ls-ivy")) === "active", "🔴 the internal person's set is still ACTIVE");
  ok(purged.length === 1 && purged[0] === rawVaultSubject(ORG, "slack", PARTNER, "U0IVYPARTNER"), "only the deactivated partner account's own subject is purged");
}

{
  console.log("2c. under the multi-tenant opt-in, a partner's deactivation does not revoke the person's other surfaces:");
  const { overrideSettingsForTest, resetSettingsForTest } = await import("../agent/settings/settings.js");
  await personWith("ls-nia", [
    { platform: "slack", tenant: PARTNER, nativeId: "U0NIA" },
    { platform: "discord", tenant: "", nativeId: "300000000000000555" },
  ]);
  overrideSettingsForTest({ identity: { allowMultiTenantPrincipals: true } });
  purged.length = 0;
  const outcome = await offboardDeactivatedAccount(report({ deliveringTenant: PARTNER, tenant: PARTNER, nativeId: "U0NIA" }));
  resetSettingsForTest();
  ok(outcome.kind === "refused" && outcome.reason === OFFBOARD_REFUSAL.crossWorkspaceSet, `refused as cross-workspace-set (got ${JSON.stringify(outcome)})`);
  ok((await setStatus("ls-nia")) === "active", "🔴 the person's set — and their Discord standing — is still ACTIVE");
  ok(purged.length === 1 && purged[0] === rawVaultSubject(ORG, "slack", PARTNER, "U0NIA"), "only the partner account's own subject is purged");
  const row = await lastRow(OFFBOARD_REFUSED_ACTION, "U0NIA");
  const blockedBy = (row?.["blockedBy"] ?? []) as string[];
  ok(blockedBy.length === 1 && blockedBy[0] === "discord/300000000000000555", `the refusal row names the account that blocked the revoke (got ${JSON.stringify(blockedBy)})`);
  ok(String(row?.["why"] ?? "").includes("discord/300000000000000555") && !String(row?.["why"] ?? "").includes("slack account in another workspace"), "…and its sentence names it too, never a second Slack account that does not exist");
}

{
  console.log("2d. a cross-workspace refusal whose own purge FAILS says so:");
  const { overrideSettingsForTest, resetSettingsForTest } = await import("../agent/settings/settings.js");
  await personWith("ls-oli", [
    { platform: "slack", tenant: PARTNER, nativeId: "U0FAIL" },
    { platform: "discord", tenant: "", nativeId: "300000000000000666" },
  ]);
  overrideSettingsForTest({ identity: { allowMultiTenantPrincipals: true } });
  const outcome = await offboardDeactivatedAccount(report({ deliveringTenant: PARTNER, tenant: PARTNER, nativeId: "U0FAIL" }));
  resetSettingsForTest();
  ok(outcome.kind === "refused" && outcome.reason === OFFBOARD_REFUSAL.crossWorkspaceSet, `refused as cross-workspace-set (got ${JSON.stringify(outcome)})`);
  const row = await lastRow(OFFBOARD_REFUSED_ACTION, "U0FAIL");
  ok(row?.["purgeFailed"] === true, "🔴 the row records purgeFailed");
  ok(String(row?.["why"] ?? "").includes("FAILED") && !String(row?.["why"] ?? "").includes("were purged"), "…and its sentence says the purge FAILED, never that it happened");
}

{
  console.log("3. a report delivered by an unadmitted workspace revokes nothing:");
  await personWith("ls-jun", [{ platform: "slack", tenant: STRANGER, nativeId: "U0JUN" }]);
  const outcome = await offboardDeactivatedAccount(report({ deliveringTenant: STRANGER, tenant: STRANGER, nativeId: "U0JUN" }));
  ok(outcome.kind === "refused" && outcome.reason === OFFBOARD_REFUSAL.unadmittedTenant, `refused as unadmitted-tenant (got ${JSON.stringify(outcome)})`);
  ok((await setStatus("ls-jun")) === "active", "🔴 the set is still active");

  const saved = domains;
  domains = [];
  await personWith("ls-moe", [{ platform: "slack", tenant: OUR, nativeId: "U0MOE" }]);
  const inert = await offboardDeactivatedAccount(report({ nativeId: "U0MOE" }));
  ok(inert.kind === "refused" && inert.reason === OFFBOARD_REFUSAL.unadmittedTenant, `🔴 an EMPTY admitted set refuses — an inert fence is not an admission (got ${JSON.stringify(inert)})`);
  ok((await setStatus("ls-moe")) === "active", "…and the set is still active");
  domains = saved;
}

{
  console.log("4. an unconfirmed deactivation revokes nothing:");
  await personWith("ls-kit", [{ platform: "slack", tenant: OUR, nativeId: "U0KIT" }]);
  const active = await offboardDeactivatedAccount(report({ nativeId: "U0KIT", confirm: async () => ({ deactivated: false, reason: "Slack users.info says the account is active" }) }));
  ok(active.kind === "refused" && active.reason === OFFBOARD_REFUSAL.unconfirmed, `a re-read that says active refuses (got ${JSON.stringify(active)})`);
  const threw = await offboardDeactivatedAccount(
    report({
      nativeId: "U0KIT",
      confirm: async () => {
        throw new Error("network down");
      },
    }),
  );
  ok(threw.kind === "refused" && threw.reason === OFFBOARD_REFUSAL.unconfirmed, "a re-read that throws refuses — an outage is not evidence");
  ok((await setStatus("ls-kit")) === "active", "🔴 the set is still active");
  const row = await lastRow(OFFBOARD_REFUSED_ACTION, "U0KIT");
  ok(String(row?.["why"] ?? "").includes("revoke_link_set"), "the refusal row tells an admin the manual lever");
}

{
  console.log("5. an UNPROVEN link does not revoke the set:");
  await personWith("ls-lee", [{ platform: "slack", tenant: OUR, nativeId: "U0LEE" }], false);
  purged.length = 0;
  const outcome = await offboardDeactivatedAccount(report({ nativeId: "U0LEE" }));
  ok(outcome.kind === "purged-unlinked", `a suggested-only account purges its own subject (got ${JSON.stringify(outcome)})`);
  ok((await setStatus("ls-lee")) === "active", "🔴 the set the account was only SUGGESTED to stays active");
  ok(purged.length === 1 && purged[0] === rawVaultSubject(ORG, "slack", OUR, "U0LEE"), "only the account's own subject is purged");
}

{
  console.log("6. an account on no link-set still loses its stored credentials:");
  purged.length = 0;
  const outcome = await offboardDeactivatedAccount(report({ nativeId: "U0SOLO" }));
  ok(outcome.kind === "purged-unlinked" && outcome.credentialsPurged === 1, `purged-unlinked (got ${JSON.stringify(outcome)})`);
  ok(purged[0] === rawVaultSubject(ORG, "slack", OUR, "U0SOLO"), "the account's own subject is purged");
  ok((await lastRow(OFFBOARD_APPLIED_ACTION, "U0SOLO"))?.["outcome"] === "purged-unlinked", "an identity.offboard.applied row records it");
}

{
  console.log("7. a second report for a revoked set changes nothing:");
  const again = await offboardDeactivatedAccount(report({ nativeId: "U0HAZEL" }));
  ok(again.kind === "purged-unlinked", `a repeat finds the account tombstoned and only re-runs the idempotent purge (got ${JSON.stringify(again)})`);
  ok((await setStatus("ls-hazel")) === "revoked", "the set stays revoked");
}

{
  const rows = await readAudit({ org: ORG, action: OFFBOARD_REFUSED_ACTION, limit: 200 });
  const reasons = new Set(rows.map((r) => String((r.detail as { reason?: unknown } | undefined)?.reason)));
  ok(["external-workspace", "unadmitted-tenant", "unconfirmed", "cross-workspace-set"].every((r) => reasons.has(r)), `the suite produced every gate's refusal (got ${[...reasons].join(", ")})`);
  ok(rows.every((r) => String((r.detail as { why?: unknown } | undefined)?.why ?? "").includes("revoke_link_set")), "every refusal row names the manual lever, as the docs say");
}

await removeTempDir(dir);
console.log(`✓ surface-offboarding: ${passed} assertions passed`);
