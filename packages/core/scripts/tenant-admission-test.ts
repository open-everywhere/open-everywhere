import assert from "node:assert/strict";
import {
  admittedTenants,
  assertSingleTenantPerTenantScopedPlatform,
  classifyTenantAdmission,
  multiTenantPrincipalsAllowed,
  soleAdmittedTenant,
  splitTenantRungs,
  tenantRungOf,
  unadmittedTenantLog,
  MULTI_TENANT_SETTING,
  UNADMITTED_TENANT_DROP_REASON,
} from "../agent/access/tenant-admission.js";
import { overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
import { isTenantScopedPlatform } from "../agent/identity/principal-key.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";

resetSettingsForTest();
const optIn = (): void => overrideSettingsForTest({ identity: { allowMultiTenantPrincipals: true } });
const optOut = (): void => overrideSettingsForTest({ identity: { allowMultiTenantPrincipals: false } });

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
  ok(msg.includes(MULTI_TENANT_SETTING) && msg.includes("agent/settings/settings.ts"), "…and names the one escape hatch and where it is written, so the message is actionable rather than a dead end");

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

  optIn();
  ok(multiTenantPrincipalsAllowed(), "the settings opt-in is readable");
  assertSingleTenantPerTenantScopedPlatform(twoTenants);
  ok(true, `${MULTI_TENANT_SETTING}: true accepts the exposure knowingly — the fence is refuse-by-DEFAULT, not refuse-always`);
  optOut();
  assert.throws(() => assertSingleTenantPerTenantScopedPlatform(twoTenants), /multi-tenant principal exposure/, "…and an explicit false re-arms it");
  n++;
  resetSettingsForTest();

  assertSingleTenantPerTenantScopedPlatform(twoTenants, true);
  ok(true, "an explicit `true` (the app's own setting, read before registration) accepts with NOTHING registered");
  optIn();
  assert.throws(() => assertSingleTenantPerTenantScopedPlatform(twoTenants, false), /multi-tenant principal exposure/, "…and an explicit `false` refuses even when the registered slot says true");
  n++;
  resetSettingsForTest();
  assert.throws(() => assertSingleTenantPerTenantScopedPlatform(twoTenants), /multi-tenant principal exposure/, "…and an omitted argument with an EMPTY slot refuses — a pre-registration caller that forgets the argument fails closed, never open");
  n++;
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

  optIn();
  ok(classifyTenantAdmission({ platform: "slack", tenant: "T_TWO", admitted }) === "proceed", "(2) the operator opt-in reaches the wake door too — one switch, both fences, so config and runtime can never disagree about the topology");
  resetSettingsForTest();
  ok(classifyTenantAdmission({ platform: "slack", tenant: "T_TWO", admitted }) === "unadmitted", "…and dropping the opt-in re-arms it (the fence is read live, not latched at import)");
}

{
  ok(tenantRungOf("slack", "T_ONE") === "workspace", "a Slack `T…` id names the WORKSPACE rung — the rung a person id is issued under");
  ok(tenantRungOf("slack", "E_OURS") === "enterprise", "🔴 a Slack `E…` id names the ENTERPRISE rung — the shape rule that lets one reach segment carry either");
  ok(tenantRungOf("discord", "E_OURS") === "workspace", "…and ONLY on Slack: no other platform has a rung above the workspace, so its ids are unchanged whatever they start with");

  const split = splitTenantRungs("slack", ["T_ONE", "E_OURS", "T_TWO"]);
  ok([...split.workspaces].sort().join(",") === "T_ONE,T_TWO", "the split puts every `T…` in the workspace set");
  ok([...split.enterprises].join(",") === "E_OURS", "…and every `E…` in the enterprise set");

  const workspaceOnly = new Set(["T_ONE"]);
  ok(
    classifyTenantAdmission({ platform: "slack", tenant: undefined, enterprise: "E_OTHER", admitted: workspaceOnly }) === "unadmitted",
    "🔴 THE DEFECT: an org-wide install's delivery names a FOREIGN Grid and no workspace — it is now REFUSED, where the workspace-only rule read the blank workspace as `names no tenant` and admitted it",
  );
  ok(
    classifyTenantAdmission({ platform: "slack", tenant: undefined, enterprise: undefined, admitted: workspaceOnly }) === "proceed",
    "NEGATIVE CONTROL for that: a delivery naming NEITHER id still proceeds — proceed-path 4 survives, so the unmapped-channel guard keeps owning the blank-workspace case",
  );

  const enterpriseOnly = new Set(["E_OURS"]);
  ok(
    classifyTenantAdmission({ platform: "slack", tenant: undefined, enterprise: "E_OURS", admitted: enterpriseOnly }) === "proceed",
    "a DECLARED Grid admits its own org-wide delivery — refusing here would break the deployment shape this rung exists to serve",
  );
  ok(
    classifyTenantAdmission({ platform: "slack", tenant: "T_SIBLING", enterprise: "E_OURS", admitted: enterpriseOnly }) === "proceed",
    "…and admits a workspace UNDER it that is not declared in its own right: Slack puts `enterprise_id` beside `team_id`, so the delivery itself says the workspace belongs to that organisation",
  );
  ok(
    classifyTenantAdmission({ platform: "slack", tenant: "T_SIBLING", enterprise: undefined, admitted: enterpriseOnly }) === "unadmitted",
    "🔴 …but a workspace that names NO organisation is still refused against an enterprise-only declaration — the admission is the operator's `E…` line doing the work, never the id shape being lenient",
  );
  ok(
    classifyTenantAdmission({ platform: "slack", tenant: "E_OURS", enterprise: undefined, admitted: enterpriseOnly }) === "unadmitted",
    "…and an id matched at the WRONG rung admits nothing: a `team_id` that happened to equal the declared Grid is judged against the workspace set, which does not hold it",
  );

  const both = new Set(["T_ONE", "E_OURS"]);
  ok(classifyTenantAdmission({ platform: "slack", tenant: "T_ONE", enterprise: "E_OTHER", admitted: both }) === "proceed", "a DECLARED workspace proceeds whatever Grid it names — admission reads the workspace first, exactly as before");
  ok(classifyTenantAdmission({ platform: "slack", tenant: "T_FOREIGN", enterprise: "E_OTHER", admitted: both }) === "unadmitted", "🔴 a foreign workspace under a foreign Grid is refused on both rungs");
  ok(classifyTenantAdmission({ platform: "slack", tenant: "T_FOREIGN", enterprise: "E_OURS", admitted: both }) === "proceed", "…while the SAME foreign workspace under the DECLARED Grid proceeds — that is what declaring an organisation means");

  ok(classifyTenantAdmission({ platform: "slack", tenant: undefined, enterprise: "E_OTHER", admitted: new Set() }) === "proceed", "(3) an EMPTY admitted set is INERT for the enterprise rung too");
  optIn();
  ok(classifyTenantAdmission({ platform: "slack", tenant: undefined, enterprise: "E_OTHER", admitted: workspaceOnly }) === "proceed", "(2) the operator opt-in reaches the enterprise rung too — one switch, every rung");
  resetSettingsForTest();
  ok(classifyTenantAdmission({ platform: "slack", tenant: undefined, enterprise: "E_OTHER", admitted: workspaceOnly }) === "unadmitted", "…and dropping it re-arms the enterprise rung (read live, not latched at import)");

  const gridPlusWorkspace = [defineDomain({ name: "grid", reach: ["slack/E_OURS/C_ORG", "slack/T_ONE/C_A"], memory: "brain" })];
  assertSingleTenantPerTenantScopedPlatform(gridPlusWorkspace);
  ok(true, "🔴 a deployment declaring its Grid AND its one workspace BOOTS — the two ids name different rungs, so counting them together would refuse the shape this ticket exists to support");
  assert.throws(
    () => assertSingleTenantPerTenantScopedPlatform([defineDomain({ name: "two", reach: ["slack/E_OURS/C_ORG", "slack/T_ONE/C_A", "slack/T_TWO/C_B"], memory: "brain" })]),
    /multi-tenant principal exposure/,
    "…and TWO workspaces still refuse to boot, Grid entry or not — the aliasing that check names is between workspaces, and an `E…` line does not launder it",
  );
  n++;
  assert.throws(
    () => assertSingleTenantPerTenantScopedPlatform([defineDomain({ name: "two-orgs", reach: ["slack/E_OURS/C_ORG", "slack/E_THEIRS/C_ORG2"], memory: "brain" })]),
    /multi-tenant principal exposure/,
    "🔴 …and TWO ENTERPRISES refuse to boot as well — counting only the workspace rung would let two organisations in with no opt-in, which is the same aliasing one rung up",
  );
  n++;

  const refusalFor = (reach: readonly string[]): string => {
    try {
      assertSingleTenantPerTenantScopedPlatform([defineDomain({ name: "r", reach: [...reach], memory: "brain" })]);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return "";
  };
  const gridRefusal = refusalFor(["slack/E_OURS/C_ORG", "slack/E_THEIRS/C_ORG2"]);
  const workspaceRefusal = refusalFor(["slack/T_ONE/C_A", "slack/T_TWO/C_B"]);
  ok(gridRefusal.includes("2 Enterprise Grid organisations"), "🔴 the GRID arm counts organisations, not workspaces — the object the operator actually declared");
  ok(gridRefusal.includes("Keep one slack Enterprise Grid organisation per deployment"), "🔴 …and its remedy names that object too, so it can be acted on");
  ok(!gridRefusal.includes("two workspaces' members"), "🔴 NEGATIVE CONTROL: the Grid arm no longer borrows the workspace arm's sentence — this is the assertion that reds if the bodies are shared again");
  ok(workspaceRefusal.includes("2 tenants"), "the WORKSPACE arm is unchanged — it still counts tenants");
  ok(workspaceRefusal.includes("two workspaces' members"), "…and still says what two workspaces share");
  ok(!workspaceRefusal.includes("Enterprise Grid"), "NEGATIVE CONTROL: the workspace arm never speaks about a Grid");
  n++;

  ok(
    soleAdmittedTenant("slack", gridPlusWorkspace) === undefined,
    "🔴 a declared Grid makes the sole admitted tenant `undefined`, even beside one declared workspace — the `E…` entry admits every workspace under the organisation, so answering `T_ONE` would stamp that workspace onto people who are in a sibling one",
  );
  ok(
    soleAdmittedTenant("slack", [defineDomain({ name: "org", reach: ["slack/E_OURS/C_ORG"], memory: "brain" })]) === undefined,
    "…and an enterprise-only deployment has none either: a Grid id is not a workspace, and putting it in a principal key would fabricate a segment",
  );
  ok(
    soleAdmittedTenant("slack", [defineDomain({ name: "one", reach: ["slack/T_ONE/C_A"], memory: "brain" })]) === "T_ONE",
    "CONTROL: a plain single-workspace deployment still resolves its one workspace — the Grid rung must not make every deployment's tenant undecidable",
  );
}

{
  const log = unadmittedTenantLog("slack", "T_TWO", new Set(["T_ONE"]));
  ok(log.includes("T_TWO") && log.includes("T_ONE"), "the log names the REFUSED tenant and what this deployment does admit");
  const orgLog = unadmittedTenantLog("slack", undefined, new Set(["T_ONE"]), "E_OTHER");
  ok(orgLog.includes("E_OTHER") && !orgLog.includes('workspace ""'), "🔴 a workspace-less refusal names the ENTERPRISE it refused — printing the absent workspace would leave the operator reading an empty string for the one fact that decided it");
  ok(log.includes("agent/memory/config/domains.ts") && log.includes(MULTI_TENANT_SETTING), "…and both remedies: declare that tenant, or opt in explicitly");
  ok(UNADMITTED_TENANT_DROP_REASON.length > 0 && UNADMITTED_TENANT_DROP_REASON.includes("alias"), "the audit reason is one greppable string that says WHY, not just THAT");
}

console.log(`tenant-admission: ${n} assertions passed`);

// proves: AP-MOD-core-access-tenant-admission

// proves: SET-076
