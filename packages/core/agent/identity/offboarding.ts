import { auditErrorDetail } from "../audit/tool-action.js";
import { appendAudit } from "../audit/audit.js";
import { purgeSubjectsCredentials } from "../credentials/purge.js";
import { admittedTenantsFromConfig, multiTenantPrincipalsAllowed, splitTenantRungs } from "../access/tenant-admission.js";
import { getOperationalStore } from "../operational/provider.js";
import { revokeLinkSet } from "./link-store.js";
import { endPersonHoldings } from "./person-holdings.js";
import { rawVaultSubject } from "./oauth-vault-share.js";
import { isTenantScopedPlatform, tryPrincipalKey } from "./principal-key.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export const OFFBOARD_APPLIED_ACTION = "identity.offboard.applied";
export const OFFBOARD_REFUSED_ACTION = "identity.offboard.refused";

export type DeactivationConfirmation =
  | { readonly deactivated: true }
  | { readonly deactivated: false; readonly reason: string };

export interface DeactivationReport {
  readonly org: string;
  readonly platform: string;
  readonly deliveringTenant: string;
  readonly deliveringEnterprise?: string;
  readonly tenant: string;
  readonly nativeId: string;
  readonly source: string;
  readonly confirm: () => Promise<DeactivationConfirmation>;
}

export type OffboardOutcome =
  | { readonly kind: "revoked"; readonly linkSetId: string; readonly note: string }
  | { readonly kind: "purged-unlinked"; readonly credentialsPurged: number }
  | { readonly kind: "refused"; readonly reason: string };

const OFFBOARD_MANUAL_LEVER = "An admin can run revoke_link_set if the person has left.";

export const OFFBOARD_REFUSAL = {
  externalWorkspace: "external-workspace",
  unadmittedTenant: "unadmitted-tenant",
  unconfirmed: "unconfirmed",
  crossWorkspaceSet: "cross-workspace-set",
} as const;

export async function offboardDeactivatedAccount(report: DeactivationReport): Promise<OffboardOutcome> {
  const account = tryPrincipalKey(report.platform, report.tenant, report.nativeId) ?? `${report.platform} account "${report.nativeId}"`;
  const refuse = async (reason: string, detail: string, extra: AuditDetail = {}): Promise<OffboardOutcome> => {
    await audit(report, OFFBOARD_REFUSED_ACTION, account, { reason, ...extra, why: `${detail} ${OFFBOARD_MANUAL_LEVER}` });
    return { kind: "refused", reason };
  };
  try {
    const delivering = report.deliveringTenant.trim();
    if (delivering.length === 0 || report.tenant.trim() !== delivering) {
      return await refuse(
        OFFBOARD_REFUSAL.externalWorkspace,
        `the account belongs to workspace "${report.tenant}", but the report was delivered by "${delivering || "(none)"}" — ` +
          `a workspace reports deactivations only for its own accounts, so nothing was revoked`,
      );
    }
    if (isTenantScopedPlatform(report.platform)) {
      const rungs = splitTenantRungs(report.platform, admittedTenantsFromConfig(report.platform));
      const enterprise = report.deliveringEnterprise?.trim() ?? "";
      if (!rungs.workspaces.has(delivering) && !(enterprise.length > 0 && rungs.enterprises.has(enterprise))) {
        return await refuse(
          OFFBOARD_REFUSAL.unadmittedTenant,
          `workspace "${delivering}" is not named in this deployment's config (a domain's reach), so nothing was revoked`,
        );
      }
    }
    const confirmation = await report.confirm().catch((err: unknown): DeactivationConfirmation => ({
      deactivated: false,
      reason: `the live re-read failed (${auditErrorDetail(err).error})`,
    }));
    if (!confirmation.deactivated) {
      return await refuse(
        OFFBOARD_REFUSAL.unconfirmed,
        `${confirmation.reason} — the deactivation was not confirmed, so nothing was revoked.`,
      );
    }
    const row = await getOperationalStore().getLinkedId(report.org, report.platform, report.tenant, report.nativeId);
    const actor = `surface-deactivation:${report.source}`;
    if (row && row.status === "confirmed") {
      const members = await getOperationalStore().listLinkedIds(report.org, row.linkSetId);
      const multiTenant = multiTenantPrincipalsAllowed();
      const elsewhere = members.filter(
        (m) =>
          m.status === "confirmed" &&
          (multiTenant ? !(m.platform === report.platform && m.tenant === report.tenant) : m.platform === report.platform && m.tenant !== report.tenant),
      );
      if (elsewhere.length > 0) {
        const purge = await purgeSubjectsCredentials([rawVaultSubject(report.org, report.platform, report.tenant, report.nativeId)]);
        const holdings = await endPersonHoldings(report.org, [{ platform: report.platform, tenant: report.tenant, nativeId: report.nativeId }], `surface-deactivation:${report.source}`);
        const blockedBy = elsewhere.map((m) => tryPrincipalKey(m.platform, m.tenant, m.nativeId) ?? `${m.platform} account "${m.nativeId}"`);
        return await refuse(
          OFFBOARD_REFUSAL.crossWorkspaceSet,
          `link-set ${row.linkSetId} also holds this person's confirmed account(s) ${blockedBy.join(", ")} outside workspace "${report.tenant}", ` +
            `so one workspace's deactivation does not revoke the whole set. ` +
            (purge.failed
              ? `The purge of the deactivated account's own credentials FAILED; re-run it with purge_link_set_credentials or revoke_link_set.`
              : `The deactivated account's own credentials were purged.`),
          { linkSetId: row.linkSetId, blockedBy, credentialsPurged: purge.purged, ...(purge.failed ? { purgeFailed: true } : {}), ...holdings },
        );
      }
      const res = await revokeLinkSet({ org: report.org, linkSetId: row.linkSetId, actor });
      if (!res.ok) return await refuse("revoke-failed", res.reason);
      await audit(report, OFFBOARD_APPLIED_ACTION, account, { outcome: "revoked", linkSetId: row.linkSetId, note: res.note, ...(res.holdings ?? {}) });
      return { kind: "revoked", linkSetId: row.linkSetId, note: res.note };
    }
    const purge = await purgeSubjectsCredentials([rawVaultSubject(report.org, report.platform, report.tenant, report.nativeId)]);
    const holdings = await endPersonHoldings(report.org, [{ platform: report.platform, tenant: report.tenant, nativeId: report.nativeId }], `surface-deactivation:${report.source}`);
    await audit(report, OFFBOARD_APPLIED_ACTION, account, {
      outcome: "purged-unlinked",
      credentialsPurged: purge.purged,
      ...(purge.failed ? { purgeFailed: true } : {}),
      ...holdings,
    });
    return { kind: "purged-unlinked", credentialsPurged: purge.purged };
  } catch (err) {
    return await refuse("error", auditErrorDetail(err).error).catch(() => ({ kind: "refused" as const, reason: "error" }));
  }
}

async function audit(report: DeactivationReport, action: string, account: string, detail: AuditDetail): Promise<void> {
  await appendAudit({
    org: report.org,
    platform: report.platform,
    workspace: report.tenant || "-",
    principalId: `surface-deactivation:${report.source}`,
    action,
    detail: { account, source: report.source, ...detail },
  }).catch(() => undefined);
}
