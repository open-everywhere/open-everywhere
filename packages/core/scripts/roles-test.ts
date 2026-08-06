import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import { roleForBinding, resolveRole, requireOrgAdmin, requireDomainAdminOrOrg, adminControlRoles } from "../agent/access/roles.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const bind = (over: Partial<SurfaceBinding> = {}): SurfaceBinding => ({
  org: "default",
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  mode: "channel",
  visibility: "public",
  trust: "internal",
  ...over,
});

const domains: Domain[] = [
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/U_ORG_ADMIN"] }),
  defineDomain({ name: "txn", channels: ["slack/T1/C_TXN"], admins: ["slack/U_TXN_ADMIN"] }),
  defineDomain({ name: "no-admins", channels: ["slack/T1/C_PLAIN"] }),
];

{
  const orgAdmin = roleForBinding(bind({ principalId: "U_ORG_ADMIN", surface: "C_TXN" }), domains);
  ok(orgAdmin.isOrgAdmin, "org admin: isOrgAdmin true");
  ok(orgAdmin.isDomainAdmin, "org admin is ALSO a domain admin everywhere (documented on Domain.admins)");
  ok(orgAdmin.domain === "txn", "domain resolves to the explicit channel domain regardless of admin tier");

  const domainAdmin = roleForBinding(bind({ principalId: "U_TXN_ADMIN", surface: "C_TXN" }), domains);
  ok(!domainAdmin.isOrgAdmin, "domain admin: isOrgAdmin false (no layering from org)");
  ok(domainAdmin.isDomainAdmin, "domain admin: isDomainAdmin true");

  const wrongDomain = roleForBinding(bind({ principalId: "U_TXN_ADMIN", surface: "C_PLAIN" }), domains);
  ok(!wrongDomain.isDomainAdmin, "a domain admin's grant is scoped — no admin standing on a different domain's channel");

  const member = roleForBinding(bind({ principalId: "U_RANDOM", surface: "C_TXN" }), domains);
  ok(!member.isOrgAdmin && !member.isDomainAdmin, "a plain member (not listed anywhere) has no admin bits");

  const noPrincipal = roleForBinding(bind({ principalId: undefined, surface: "C_TXN" }), domains);
  ok(!noPrincipal.isOrgAdmin && !noPrincipal.isDomainAdmin, "FAIL-CLOSED: no verified principalId -> no admin bits");
  ok(noPrincipal.principalId === undefined, "no principalId is reflected on the role, not defaulted");

  const unknownChannel = roleForBinding(bind({ principalId: "U_ORG_ADMIN", surface: "C_NOWHERE" }), domains);
  ok(unknownChannel.isOrgAdmin, "org admin still org-admin on an unassigned channel");
  ok(unknownChannel.domain === undefined, "an unassigned channel resolves to no explicit domain");

  const noConfig = roleForBinding(bind({ principalId: "U_ORG_ADMIN" }), []);
  ok(!noConfig.isOrgAdmin && !noConfig.isDomainAdmin, "FAIL-CLOSED: no domains configured -> no admin bits even for a would-be admin id");

  const inThread = roleForBinding(bind({ principalId: "U_TXN_ADMIN", surface: "T_THREAD", domainSurface: "C_TXN" }), domains);
  ok(inThread.isDomainAdmin && inThread.domain === "txn", "thread grain: domainSurface (parent channel) resolves the domain — admin standing holds in the thread");
  const inThreadNoParent = roleForBinding(bind({ principalId: "U_TXN_ADMIN", surface: "T_THREAD" }), domains);
  ok(!inThreadNoParent.isDomainAdmin && inThreadNoParent.domain === undefined, "thread grain: no domainSurface (fail-open ingress) -> thread key resolves no domain, standing fails closed");
}

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  domainsForSurface: () => [],
});

function ctxFor(principalId: string | undefined, channelId: string): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          principalId: principalId ?? "",
          principalType: "slack-user",
          attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel", is_private: "false" },
        },
      },
    },
  };
}

{
  const role = resolveRole(ctxFor("U_ORG_ADMIN", "C_TXN"));
  ok(role.isOrgAdmin && role.isDomainAdmin, "resolveRole agrees with the pure matrix for a real ctx");

  assert.doesNotThrow(() => requireOrgAdmin(ctxFor("U_ORG_ADMIN", "C_TXN")), "requireOrgAdmin passes for an org admin");
  n++;
  {
    let threw = false;
    try {
      requireOrgAdmin(ctxFor("U_TXN_ADMIN", "C_TXN"));
    } catch (err) {
      threw = true;
      ok(/org admin/i.test(String(err)) && /U_TXN_ADMIN/.test(String(err)), "requireOrgAdmin's error names the missing role and the caller's id");
    }
    ok(threw, "requireOrgAdmin throws for a non-org-admin");
  }
  {
    let threw = false;
    try {
      requireOrgAdmin(ctxFor(undefined, "C_TXN"));
    } catch (err) {
      threw = true;
      ok(/no verified sender/i.test(String(err)), "requireOrgAdmin's error explains a missing principal distinctly");
    }
    ok(threw, "requireOrgAdmin throws when there's no verified sender");
  }

  assert.doesNotThrow(() => requireDomainAdminOrOrg(ctxFor("U_TXN_ADMIN", "C_TXN")), "requireDomainAdminOrOrg passes for the domain's own admin");
  n++;
  assert.doesNotThrow(() => requireDomainAdminOrOrg(ctxFor("U_ORG_ADMIN", "C_TXN")), "requireDomainAdminOrOrg passes for an org admin (covers every domain)");
  n++;
  {
    let threw = false;
    try {
      requireDomainAdminOrOrg(ctxFor("U_RANDOM", "C_TXN"));
    } catch (err) {
      threw = true;
      ok(/domain "txn"/.test(String(err)), "requireDomainAdminOrOrg's error names the resolved domain to add the id to");
    }
    ok(threw, "requireDomainAdminOrOrg throws for a plain member");
  }
  {
    let threw = false;
    try {
      requireDomainAdminOrOrg(ctxFor("U_RANDOM", "C_NOWHERE"));
    } catch (err) {
      threw = true;
      ok(/org admin/i.test(String(err)), "on an unassigned channel, the error explains only an org admin can act");
    }
    ok(threw, "requireDomainAdminOrOrg throws on an unassigned channel for a non-org-admin");
  }
}

{
  const lsDomains: Domain[] = [
    defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["linkSet:set-org"] }),
    defineDomain({ name: "txn", channels: ["slack/T1/C_TXN"], admins: ["linkSet:set-txn"] }),
  ];
  const lsOrg = roleForBinding(bind({ principalId: "U_ANY", surface: "C_TXN" }), lsDomains, ["set-org"]);
  ok(lsOrg.isOrgAdmin && lsOrg.isDomainAdmin, "a link-set ORG admin (caller's confirmed set == referenced) is org + domain admin");
  const lsNone = roleForBinding(bind({ principalId: "U_ANY", surface: "C_TXN" }), lsDomains);
  ok(!lsNone.isOrgAdmin && !lsNone.isDomainAdmin, "🔴 no precomputed link-set membership (sync/fail-closed default) → a link-set roster admits nobody");
  const lsOther = roleForBinding(bind({ principalId: "U_ANY", surface: "C_TXN" }), lsDomains, ["set-different"]);
  ok(!lsOther.isOrgAdmin && !lsOther.isDomainAdmin, "a DIFFERENT confirmed set does not match the referenced link-set");
  const lsDom = roleForBinding(bind({ principalId: "U_ANY", surface: "C_TXN" }), lsDomains, ["set-txn"]);
  ok(!lsDom.isOrgAdmin && lsDom.isDomainAdmin, "a link-set DOMAIN admin holds on the domain's channel, not org-wide");
  const lsWrongChannel = roleForBinding(bind({ principalId: "U_ANY", surface: "C_PLAIN" }), lsDomains, ["set-txn"]);
  ok(!lsWrongChannel.isDomainAdmin, "a link-set domain admin has no standing on another domain's channel");

  ok(adminControlRoles("U_ANY", lsDomains, "slack", ["set-org"]).join(",") === "admin", "adminControlRoles: a link-set org admin → [\"admin\"]");
  ok(adminControlRoles("U_ANY", lsDomains, "slack", ["set-txn"]).join(",") === "domain:txn", "adminControlRoles: a link-set domain admin → [\"domain:txn\"], regardless of channel");
  ok(adminControlRoles("U_ANY", lsDomains, "slack").length === 0, "🔴 adminControlRoles fail-closed: no link-set membership → no roles from a link-set roster");
  ok(adminControlRoles("U_ANY", lsDomains, "slack", ["set-other"]).length === 0, "adminControlRoles: an unrelated set grants no roles");
}

console.log(`\n✓ roles: ${n} assertions passed (config-as-code RBAC: org/domain admin matrix + link-set roster entries + throw-message wording)\n`);
