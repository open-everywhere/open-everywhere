process.env.OE_SQLITE_PATH = ":memory:";
_setDeploymentIdentityForTest({ org: "acme" });

import assert from "node:assert/strict";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import { registerOperationalStore, resetOperationalStore, getOperationalStore } from "../agent/operational/provider.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { MULTI_TENANT_ENV } from "../agent/access/tenant-admission.js";
import {
  classifyDmWorkspaceReachability,
  dmWorkspaceReachableFromConfig,
  notifyLinkSetMembers,
  registerPostArm,
  DM_WORKSPACE_UNREACHABLE_REASON,
} from "../agent/channels/post-arms.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

delete process.env[MULTI_TENANT_ENV];
registerOperationalStore(sqliteOperationalStore);
resetOperationalStore();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ORG = "acme";

function configWithSlackTenants(tenants: readonly string[]): void {
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadDomains: () => tenants.map((t, i) => defineDomain({ name: `d${i}`, reach: [`slack/${t}/C1`] })),
  });
}

{
  ok(
    classifyDmWorkspaceReachability("slack", "T_ONE", "T_ONE").reachable === true,
    "the ORDINARY case: target and arm name the same workspace ⇒ reachable — untouched by this floor",
  );

  const bad = classifyDmWorkspaceReachability("slack", "T_TWO", "T_ONE");
  ok(bad.reachable === false, "🔴 THE HEADLINE CASE: a KNOWN arm tenant that differs from the target's is UNREACHABLE — this is the mis-route OPE-354 makes loud");
  if (!bad.reachable) {
    ok(bad.targetTenant === "T_TWO" && bad.armTenant === "T_ONE", "…and the result NAMES both workspaces, for the audit row");
  }

  ok(
    classifyDmWorkspaceReachability("slack", "  T_ONE  ", "T_ONE").reachable === true,
    "a padded target tenant is trimmed before comparison — whitespace doesn't falsely trip the floor",
  );
  ok(
    classifyDmWorkspaceReachability("slack", " T_TWO ", "T_ONE").reachable === false,
    "…and trimming doesn't launder a real mismatch either",
  );

  ok(
    classifyDmWorkspaceReachability("discord", "G_OTHER", "G_MINE").reachable === true,
    "NOT a tenant-scoped platform ⇒ always reachable, even with two different-looking tenant strings — vendor-global ids can't alias across workspaces",
  );
  ok(
    classifyDmWorkspaceReachability("slack", undefined, "T_ONE").reachable === true,
    "NO target tenant named ⇒ reachable — a blank is not evidence of a FOREIGN workspace, so comparing it would invent a mismatch, not detect one",
  );
  ok(
    classifyDmWorkspaceReachability("slack", "", "T_ONE").reachable === true,
    "…same for an explicit empty string (LINK_TENANT_NONE — a pre-OPE-309 row, or a non-tenant-scoped account's tenant)",
  );
  ok(
    classifyDmWorkspaceReachability("slack", "   ", "T_ONE").reachable === true,
    "…and a whitespace-only string reads the same as blank",
  );

  ok(
    classifyDmWorkspaceReachability("slack", "T_TWO", undefined).reachable === true,
    "🔴 an INDETERMINATE arm tenant (undefined) ⇒ reachable — attempt the send, same as pre-OPE-354 behaviour; this floor may only ADD loudness to an already-mis-routing delivery, never remove standing from a working one",
  );
}

{
  configWithSlackTenants(["T_ONE"]);
  ok(dmWorkspaceReachableFromConfig("slack", "T_ONE").reachable === true, "one declared tenant, matching target ⇒ reachable");
  const skip = dmWorkspaceReachableFromConfig("slack", "T_TWO");
  ok(skip.reachable === false, "one declared tenant, DIFFERENT target ⇒ unreachable — this is soleAdmittedTenantFromConfig doing the real work");
  if (!skip.reachable) ok(skip.armTenant === "T_ONE" && skip.targetTenant === "T_TWO", "…naming the real declared tenant as the arm's");

  configWithSlackTenants([]);
  ok(dmWorkspaceReachableFromConfig("slack", "T_TWO").reachable === true, "NOTHING declared for slack ⇒ indeterminate arm tenant ⇒ reachable (fence inert, same posture as the wake door)");

  configWithSlackTenants(["T_ONE", "T_TWO"]);
  ok(dmWorkspaceReachableFromConfig("slack", "T_ONE").reachable === true, "TWO declared tenants (only possible with the multi-tenant opt-in armed elsewhere) ⇒ soleAdmittedTenant is undefined ⇒ indeterminate ⇒ reachable, even though this specific target happens to match one of them");
  ok(dmWorkspaceReachableFromConfig("slack", "T_THREE").reachable === true, "…and reachable even for a target that matches NEITHER declared tenant — the comparison genuinely cannot be made, so it is not attempted");
}

{
  configWithSlackTenants(["T_ONE"]);

  const sent: { platform: string; to: string; tenant: string | undefined }[] = [];
  registerPostArm({
    platform: "slack",
    deliverDirectMessage: async (input) => {
      sent.push({ platform: "slack", to: input.principalId, tenant: undefined });
      return { surfaceId: `D-${input.principalId}`, messageId: "m1" };
    },
  });

  const store = getOperationalStore();
  const now = "2026-08-09T00:00:00Z";
  const linkSetId = "ls-ope-354";
  await store.putLinkSet(ORG, { org: ORG, id: linkSetId, handle: "slack/T_ONE/U_HOME", status: "active", createdAt: now, updatedAt: now });
  await store.insertLinkedId(ORG, {
    org: ORG,
    linkSetId,
    platform: "slack",
    tenant: "T_ONE",
    nativeId: "U_HOME",
    status: "confirmed",
    establishedBy: "test",
    createdAt: now,
    updatedAt: now,
  });
  await store.insertLinkedId(ORG, {
    org: ORG,
    linkSetId,
    platform: "slack",
    tenant: "T_TWO",
    nativeId: "U_AWAY",
    status: "confirmed",
    establishedBy: "test",
    createdAt: now,
    updatedAt: now,
  });

  const delivered = await notifyLinkSetMembers(ORG, linkSetId, "the set changed");

  ok(delivered === 1, "notifyLinkSetMembers reports exactly ONE delivery — the reachable member, not the unreachable one");
  ok(sent.length === 1 && sent[0]!.to === "U_HOME", "🔴 the arm's deliverDirectMessage was called ONLY for the reachable (T_ONE) member — U_AWAY's send was never attempted, not merely failed");
  ok(!sent.some((s) => s.to === "U_AWAY"), "…U_AWAY never appears in what the arm actually sent, at all");

  const rows = await store.readAudit({ org: ORG, action: "dm.delivery.skipped" });
  ok(rows.length === 1, "exactly one dm.delivery.skipped audit row was written");
  const row = rows[0]!;
  ok(row.platform === "slack", "the audit row names the PLATFORM the skip happened on");
  ok(row.workspace === "T_TWO", "the audit row's top-level workspace is the TARGET's workspace — the one we could not reach");
  const detail = row.detail as { reason?: string; linkSetId?: string; targetWorkspaceId?: string; armWorkspaceId?: string };
  ok(detail.reason === DM_WORKSPACE_UNREACHABLE_REASON, "detail.reason is the shared, greppable constant — never a one-off string");
  ok(detail.linkSetId === linkSetId, "detail carries the linkSetId — an operator can join it back to the set");
  ok(detail.targetWorkspaceId === "T_TWO" && detail.armWorkspaceId === "T_ONE", "detail NAMES both workspaces — the target's and the arm's — ids only, never message content");
  ok(
    !JSON.stringify(row).includes("the set changed"),
    "🔴 the audit row carries NAMES/IDS ONLY — the notice text itself never reaches it",
  );

  registerPostArm({ platform: "slack" });
}

console.log(`dm-workspace-reachability: ${n} assertions passed`);
