import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import { resolveAnalyticsScope, isAmbientNonAddressedTurn } from "../agent/access/analytics-scope.js";
import type { BindableContext } from "../agent/identity/binding.js";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();


let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const domains: Domain[] = [
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/U_ORG"] }),
  defineDomain({ name: "eng", channels: ["slack/T1/CA"], admins: ["slack/U_ENG"] }),
];

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  domainsForSurface: () => [],
});

interface CtxOpts {
  channelType?: string;
  isPrivate?: string;
  grain?: string;
  addressing?: string;
  token?: string;
}
function ctxFor(principalId: string | undefined, channelId: string, opts: CtxOpts = {}): BindableContext {
  const attributes: Record<string, string> = {
    team_id: "T1",
    channel_id: channelId,
    channel_type: opts.channelType ?? "channel",
    is_private: opts.isPrivate ?? "false",
    trust_checked: "true",
  };
  if (opts.grain) attributes.oe_grain = opts.grain;
  if (opts.addressing) attributes.oe_addressing = opts.addressing;
  return {
    channel: { kind: "slack", ...(opts.token ? { continuationToken: opts.token } : {}) },
    session: { auth: { current: { principalId: principalId ?? "", principalType: "slack-user", attributes } } },
  } as BindableContext;
}

{
  const s = resolveAnalyticsScope(ctxFor("U_ORG", "CA"), "org");
  ok(s.grain === "org" && s.rowMode && s.auditDetail, "org admin @ org grain: rows + audit detail");
  ok(!s.dmUnmasked, "org admin asking in a CHANNEL: DM surfaces stay masked (room audience)");

  const inDm = resolveAnalyticsScope(ctxFor("U_ORG", "D9", { channelType: "im" }), "org");
  ok(inDm.dmUnmasked, "org admin asking from their OWN DM: DM surfaces may unmask");

  assert.throws(() => resolveAnalyticsScope(ctxFor("U_ENG", "CA"), "org"), /org admin/i, "domain admin @ org grain: REFUSED");
  n++;
  assert.throws(() => resolveAnalyticsScope(ctxFor("U_RANDOM", "CA"), "org"), /org admin/i, "plain member @ org grain: REFUSED");
  n++;
}

{
  const admin = resolveAnalyticsScope(ctxFor("U_ENG", "CA"), "domain");
  ok(admin.grain === "domain" && admin.domain === "eng" && admin.rowMode, "domain admin @ own domain: rows mode");
  ok(!admin.auditDetail, "domain admin: NO audit detail (org-admin only)");

  const orgAsDomain = resolveAnalyticsScope(ctxFor("U_ORG", "CA"), "domain");
  ok(orgAsDomain.rowMode && orgAsDomain.auditDetail, "org admin @ domain grain: rows + detail (org admin is domain admin everywhere)");

  const member = resolveAnalyticsScope(ctxFor("U_RANDOM", "CA"), "domain");
  ok(member.grain === "domain" && !member.rowMode, "plain member @ own domain: AGGREGATES ONLY (no rows)");

  assert.throws(() => resolveAnalyticsScope(ctxFor("U_ENG", "D9", { channelType: "im" }), "domain"), /DM|domain/i, "domain grain from a DM: REFUSED (a DM has no memory domain)");
  n++;
}

{
  const self = resolveAnalyticsScope(ctxFor("U_RANDOM", "CA"), "self");
  ok(self.grain === "self" && self.principalId === "U_RANDOM" && self.rowMode, "any member @ self grain: their own rows");
  ok(!self.dmUnmasked, "self grain never unmasks DMs for the room");
}

{
  for (const g of ["org", "domain", "self"] as const) {
    assert.throws(() => resolveAnalyticsScope(ctxFor(undefined, "CA"), g), /verified sender/i, `no principal @ ${g} grain: fail-closed refusal`);
    n++;
  }
}

{
  ok(isAmbientNonAddressedTurn(ctxFor("U_ORG", "CA", { grain: "standing" })), "standing seat, no addressing → AMBIENT (rows held)");
  ok(!isAmbientNonAddressedTurn(ctxFor("U_ORG", "CA", { grain: "standing", addressing: "direct-mention" })), "standing seat, direct-mention → NOT ambient (rows allowed)");
  ok(!isAmbientNonAddressedTurn(ctxFor("U_ORG", "CA")), "no standing stamp (a DM/native/thread direct turn) → NOT ambient");
}

console.log(`\n✓ analytics-scope: ${n} assertions passed (policy matrix org/domain/self × standing, DM-unmask audience rule, ambient-wake belt)\n`);
