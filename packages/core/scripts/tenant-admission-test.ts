import assert from "node:assert/strict";
import {
  admittedTenants,
  assertSingleTenantPerTenantScopedPlatform,
  classifyTenantAdmission,
  multiTenantPrincipalsAllowed,
  unadmittedTenantLog,
  MULTI_TENANT_ENV,
  UNADMITTED_TENANT_DROP_REASON,
} from "../agent/access/tenant-admission.js";
import { isTenantScopedPlatform } from "../agent/identity/principal-key.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";

delete process.env[MULTI_TENANT_ENV];

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  ok(isTenantScopedPlatform("slack"), "slack is tenant-scoped: its member ids are issued per workspace, and team_id rides every delivery");
  for (const p of ["discord", "github", "linear", "notion", "teams", "local"]) {
    ok(!isTenantScopedPlatform(p), `${p} is NOT in the set — the slot stays empty until a per-mapper test earns it (no plausible-prior fill)`);
  }
  ok(!isTenantScopedPlatform(undefined), "an absent platform is not tenant-scoped (fail-open, matching the set's documented posture)");
}

{
  const domains: Domain[] = [
    defineDomain({ name: "eng", reach: ["slack/T_ONE/C_A", "slack/T_ONE/C_B", "discord/G9/C_DEV"], memory: "brain" }),
    defineDomain({ name: "repos", reach: ["github/acme", "slack/T_ONE"], memory: "brain" }),
  ];
  ok([...admittedTenants("slack", domains)].join(",") === "T_ONE", "the admitted set is the DISTINCT tenants of the platform's channel keys + container claims");
  ok([...admittedTenants("discord", domains)].join(",") === "G9", "…per platform, so one platform's tenants never admit another's");
  ok(admittedTenants("teams", domains).size === 0, "a platform with nothing declared admits nothing (which the classifier reads as `fence inert`, never `refuse all`)");

  const malformed: Domain[] = [defineDomain({ name: "x", reach: ["slack/"], memory: "brain" })];
  ok(admittedTenants("slack", malformed).size === 0, "a key that names no tenant contributes none — inventing one from a broken string would hide the real bug");

  const globOnly: Domain[] = [defineDomain({ name: "pay", reach: ["github/acme/pay-*", "slack/T_ONE/C_PAY_*"], memory: "brain" })];
  ok([...admittedTenants("github", globOnly)].join(",") === "acme", "a glob-only claim admits its tenant (the `*` can only ever be in the LAST segment, so the tenant read is never a pattern)");
  ok([...admittedTenants("slack", globOnly)].join(",") === "T_ONE", "…on every platform, not just the one the two-segment form was written for");
}

{
  const oneTenant: Domain[] = [defineDomain({ name: "eng", reach: ["slack/T_ONE/C_A", "slack/T_ONE/C_B"], memory: "brain" })];
  assertSingleTenantPerTenantScopedPlatform(oneTenant);
  ok(true, "ONE Slack tenant across many channels loads — the ordinary deployment is untouched");

  const twoTenants: Domain[] = [
    defineDomain({ name: "eng", reach: ["slack/T_ONE/C_A"], memory: "brain" }),
    defineDomain({ name: "ops", reach: ["slack/T_TWO/C_B"], memory: "brain" }),
  ];
  let msg = "";
  try {
    assertSingleTenantPerTenantScopedPlatform(twoTenants);
    ok(false, "🔴 TWO Slack tenants must be refused at config load (did not throw)");
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
    ok(true, "🔴 TWO Slack tenants are refused at CONFIG LOAD — fail loud at boot, because the failure it prevents produces no error anywhere, only the wrong answer to `is this an admin`");
  }
  ok(msg.includes('"T_ONE"') && msg.includes('"T_TWO"'), `…and the message NAMES both tenants, so the operator can see what collided (got: ${msg})`);
  ok(msg.includes(MULTI_TENANT_ENV), "…and names the one escape hatch, so the message is actionable rather than a dead end");

  const claimAndRoster: Domain[] = [
    defineDomain({ name: "eng", reach: ["slack/T_ONE/C_A"], memory: "brain" }),
    defineDomain({ name: "ops", reach: ["slack/T_TWO"], memory: "brain" }),
  ];
  assert.throws(() => assertSingleTenantPerTenantScopedPlatform(claimAndRoster), /multi-tenant principal exposure/, "a CONTAINER claim admits a tenant like a roster entry — a second one is the same exposure, not a loophole");
  n++;

  const twoGithubOrgs: Domain[] = [
    defineDomain({ name: "a", reach: ["github/acme"], memory: "brain" }),
    defineDomain({ name: "b", reach: ["github/other"], memory: "brain" }),
  ];
  assertSingleTenantPerTenantScopedPlatform(twoGithubOrgs);
  ok(true, "🔴 two GitHub owners load fine — the fence is about tenant-SCOPED ids, not about multi-tenancy as such");

  process.env[MULTI_TENANT_ENV] = "1";
  ok(multiTenantPrincipalsAllowed(), "the env opt-in is readable");
  assertSingleTenantPerTenantScopedPlatform(twoTenants);
  ok(true, `${MULTI_TENANT_ENV}=1 accepts the exposure knowingly — the fence is refuse-by-DEFAULT, not refuse-always`);
  process.env[MULTI_TENANT_ENV] = "0";
  assert.throws(() => assertSingleTenantPerTenantScopedPlatform(twoTenants), /multi-tenant principal exposure/, "…and only the literal \"1\" arms it (a stray \"0\"/\"false\" must not read as consent)");
  n++;
  delete process.env[MULTI_TENANT_ENV];
}

{
  const admitted = new Set(["T_ONE"]);
  ok(classifyTenantAdmission({ platform: "slack", tenant: "T_ONE", admitted }) === "proceed", "a delivery from the ADMITTED tenant proceeds — the ordinary path is untouched");
  ok(classifyTenantAdmission({ platform: "slack", tenant: "T_TWO", admitted }) === "unadmitted", "🔴 a delivery from a tenant this deployment never declared is UNADMITTED — the drop that makes phases 1–2 separable rather than urgent");
  ok(classifyTenantAdmission({ platform: "slack", tenant: "  T_TWO  ", admitted }) === "unadmitted", "…and whitespace doesn't launder it");
  ok(classifyTenantAdmission({ platform: "slack", tenant: " T_ONE ", admitted }) === "proceed", "…while a padded ADMITTED tenant still proceeds (the trim cuts both ways, so the fence can't be evaded OR falsely tripped)");

  ok(classifyTenantAdmission({ platform: "discord", tenant: "G_OTHER", admitted: new Set(["G9"]) }) === "proceed", "(1) a NON-tenant-scoped platform is not fenced — its ids are vendor-global, so a second guild is not an aliasing event");
  ok(classifyTenantAdmission({ platform: "slack", tenant: "T_TWO", admitted: new Set() }) === "proceed", "🔴 (3) an EMPTY admitted set is INERT — memory is opt-in, and a fresh clone that declares no domains must keep answering everywhere");
  ok(classifyTenantAdmission({ platform: "slack", tenant: undefined, admitted }) === "proceed", "(4) a delivery naming NO tenant proceeds — a blank tenant is not evidence of a foreign one, and the unmapped-channel guard already drops the channel case");
  ok(classifyTenantAdmission({ platform: "slack", tenant: "   ", admitted }) === "proceed", "…same for a blank string (the two are the same fact)");

  process.env[MULTI_TENANT_ENV] = "1";
  ok(classifyTenantAdmission({ platform: "slack", tenant: "T_TWO", admitted }) === "proceed", "(2) the operator opt-in reaches the wake door too — one switch, both fences, so config and runtime can never disagree about the topology");
  delete process.env[MULTI_TENANT_ENV];
  ok(classifyTenantAdmission({ platform: "slack", tenant: "T_TWO", admitted }) === "unadmitted", "…and dropping the opt-in re-arms it (the fence is read live, not latched at import)");
}

{
  const log = unadmittedTenantLog("slack", "T_TWO", new Set(["T_ONE"]));
  ok(log.includes("T_TWO") && log.includes("T_ONE"), "the log names the REFUSED tenant and what this deployment does admit");
  ok(log.includes("agent/memory/config/domains.ts") && log.includes(MULTI_TENANT_ENV), "…and both remedies: declare that tenant, or opt in explicitly");
  ok(UNADMITTED_TENANT_DROP_REASON.length > 0 && UNADMITTED_TENANT_DROP_REASON.includes("alias"), "the audit reason is one greppable string that says WHY, not just THAT");
}

console.log(`tenant-admission: ${n} assertions passed`);
