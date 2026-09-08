import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import { assertDomainsValid, defineDomain, type Domain } from "../agent/memory/domain.js";
import { roleForBinding, resolveRole, requireOrgAdmin, requireDomainAdminOrOrg, adminControlRoles } from "../agent/access/roles.js";
import { sharedOrgAdminSubject } from "../agent/access/admin-standing.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const throwsWith = (fn: () => void, fragment: string, label: string) => {
  try {
    fn();
  } catch (err) {
    ok(String(err).includes(fragment), `${label} (got: ${String(err).slice(0, 200)})`);
    return;
  }
  ok(false, `${label} (did not throw)`);
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
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/T1/U_ORG_ADMIN"] }),
  defineDomain({ name: "txn", reach: ["slack/T1/C_TXN"], admins: ["slack/T1/U_TXN_ADMIN"] }),
  defineDomain({ name: "no-admins", reach: ["slack/T1/C_PLAIN"] }),
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
  throwsWith(
    () => assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["linkSet:set-org"] })]),
    "exact-id",
    "a `linkSet:<id>` admin entry throws loud at config load (admin is exact-id only)",
  );
  const exactDomains: Domain[] = [
    defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/T1/U_EXACT_ORG"] }),
    defineDomain({ name: "txn", reach: ["slack/T1/C_TXN"], admins: ["slack/T1/U_EXACT_TXN"] }),
  ];
  assertDomainsValid(exactDomains);
  const exOrg = roleForBinding(bind({ principalId: "U_EXACT_ORG", surface: "C_TXN" }), exactDomains);
  ok(exOrg.isOrgAdmin && exOrg.isDomainAdmin, "an exact `platform/<id>` ORG admin is org + domain admin everywhere");
  const exDom = roleForBinding(bind({ principalId: "U_EXACT_TXN", surface: "C_TXN" }), exactDomains);
  ok(!exDom.isOrgAdmin && exDom.isDomainAdmin, "an exact `platform/<id>` DOMAIN admin holds on the domain's channel, not org-wide");
  ok(adminControlRoles("U_EXACT_ORG", exactDomains, "slack", "T1").join(",") === "admin", "adminControlRoles: an exact org admin → [\"admin\"]");
  ok(adminControlRoles("U_EXACT_TXN", exactDomains, "slack", "T1").join(",") === "domain:txn", "adminControlRoles: an exact domain admin → [\"domain:txn\"], regardless of channel");
}

{
  const twoAdminDomains: Domain[] = [
    defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/T1/U_ORG_A", "slack/T1/U_ORG_B"] }),
    defineDomain({ name: "txn", reach: ["slack/T1/C_TXN"], admins: ["slack/T1/U_TXN_ADMIN"] }),
  ];
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => twoAdminDomains,
    loadSilos: () => [],
    domainsForSurface: () => [],
  } as never);
  const b = bind({ principalId: "U_ORG_A", surface: "C_TXN" });

  const served = sharedOrgAdminSubject(b, "U_ORG_A", ["U_ORG_A", "U_ORG_B"]);
  ok(served === "U_ORG_A", "two ORG admins woke the turn → SERVED, under the acting principal (one of the equals)");
  ok(sharedOrgAdminSubject(b, "U_ORG_B", ["U_ORG_A", "U_ORG_B"]) === "U_ORG_B", "…and under whichever of them the delivery's auth carried");
  ok(sharedOrgAdminSubject(b, "U_SOMEONE_ELSE", ["U_ORG_B", "U_ORG_A"]) === "U_ORG_A", "…falling back to the FIRST SORTED id when the acting principal is not a candidate — deterministic, never queue order");

  ok(sharedOrgAdminSubject(b, "U_ORG_A", ["U_ORG_A", "U_RANDOM"]) === undefined, "🔴 ONE non-admin among the candidates refuses the WHOLE turn");
  ok(sharedOrgAdminSubject(b, "U_ORG_A", ["U_ORG_A", "U_TXN_ADMIN"]) === undefined, "🔴 a DOMAIN admin is not org-admin standing — the set is not identical, so it refuses");
  ok(sharedOrgAdminSubject(b, "U_TXN_ADMIN", ["U_TXN_ADMIN", "U_TXN_ADMIN2"]) === undefined, "🔴 two DOMAIN admins of the same domain still refuse — the rule is ORG admin only");
  ok(sharedOrgAdminSubject(b, "U_ORG_A", undefined) === undefined, "🔴 an unverified turn with NO candidate set refuses — the rule needs the WHOLE set");
  ok(sharedOrgAdminSubject(b, "U_ORG_A", ["U_ORG_A"]) === undefined, "🔴 a single candidate is not a several-askers turn — it refuses rather than rubber-stamping");
  ok(sharedOrgAdminSubject(b, "U_ORG_A", []) === undefined, "🔴 an empty candidate set refuses");

  ok(sharedOrgAdminSubject(bind({ principalId: "U_ORG_A", workspace: "T_OTHER" }), "U_ORG_A", ["U_ORG_A", "U_ORG_B"]) === undefined, "🔴 the same ids in ANOTHER workspace hold nothing — the roster names slack/T1/…");
  ok(sharedOrgAdminSubject(bind({ principalId: "U_ORG_A", platform: "discord" }), "U_ORG_A", ["U_ORG_A", "U_ORG_B"]) === undefined, "🔴 the same ids on ANOTHER platform hold nothing");

  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "org", match: "org", memory: "org-brain" })],
    loadSilos: () => [],
    domainsForSurface: () => [],
  } as never);
  ok(sharedOrgAdminSubject(b, "U_ORG_A", ["U_ORG_A", "U_ORG_B"]) === undefined, "🔴 an org pseudo-domain with no admins roster refuses every candidate set");
}

console.log(`\n✓ roles: ${n} assertions passed (config-as-code RBAC: org/domain admin matrix + exact-id-only admin rosters + the all-candidates serve rule + throw-message wording)\n`);
