import {
  awsRoleSessionName,
  planAwsIdentity,
  resolveAwsIdentity,
  registerAwsIdentityProvider,
  resetAwsIdentityProvider,
  awsIdentityProvider,
  requireAwsIdentityProvider,
  type AwsCredentials,
  type AwsIdentityProvider,
  type AwsIdentityRequest,
} from "../agent/connections/aws-identity.js";
import {
  registerAwsExecutor,
  resetAwsExecutor,
  awsExecutor,
  requireAwsExecutor,
  type AwsExecutor,
} from "../agent/connections/aws-exec.js";
import { assertBundlesValid, type AwsRoleGrant, type Binding, type Bundle } from "../agent/access/bundle.js";
import { resolveAccess, type ResolveRequest } from "../agent/access/resolver.js";
import { registerConfig } from "../agent/access/config.js";
import type { BindableContext } from "../agent/identity/binding.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function throwsWith(fn: () => unknown, fragment: string, label: string): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes(fragment), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

async function rejectsWith(fn: () => Promise<unknown>, fragment: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes(fragment), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not reject)`);
}

const g1: AwsRoleGrant = { roleArn: "arn:aws:iam::123456789012:role/oe-payments", region: "eu-west-2" };
const g2: AwsRoleGrant = { roleArn: "arn:aws:iam::123456789012:role/oe-readonly" };

function plan(over: Partial<Parameters<typeof planAwsIdentity>[0]> = {}) {
  return planAwsIdentity({
    grants: [g1],
    mode: "channel",
    actingPrincipalId: undefined,
    domains: ["payments"],
    surfaceKey: "slack/T1/C1",
    ...over,
  });
}

const SESSION_NAME = /^[\w+=,.@-]{2,64}$/u;
function validSessionName(name: string): boolean {
  return name.startsWith("oe-") && name.length <= 64 && SESSION_NAME.test(name);
}

{
  throwsWith(
    () => plan({ grants: [] }),
    "no AWS role",
    "plan: empty grants fail closed (no AWS role granted to this scope)",
  );
}

{
  const p = plan({ grants: [g1], domains: ["payments"] });
  ok(p.kind === "domain-role", "plan: single grant, no opts → domain-role (the standing service identity)");
  ok(p.grant === g1, "plan: the sole granted role is selected");
  ok(p.roleSessionName === awsRoleSessionName("payments"), "plan: domain-role RoleSessionName derives from domains[0]");
  ok(p.roleSessionName === "oe-payments", "plan: derived RoleSessionName is the oe-<domain> form");
  ok(p.principalId === undefined, "plan: a domain-role plan names no principal (it is not a person's identity)");
  ok(validSessionName(p.roleSessionName), "plan: domain-role RoleSessionName is a valid oe-… name ≤64");

  const p2 = plan({ grants: [g1], domains: [], surfaceKey: "slack/T1/C1" });
  ok(p2.roleSessionName === awsRoleSessionName("slack/T1/C1"), "plan: with no domains, RoleSessionName falls back to the surface key");
  ok(validSessionName(p2.roleSessionName), "plan: surface-key RoleSessionName is still a valid oe-… name");
}

{
  throwsWith(
    () => plan({ grants: [g1, g2] }),
    "disambiguate",
    "plan: multiple grants with no roleArn → refuse (ambiguous), asks to disambiguate",
  );

  const p = plan({ grants: [g1, g2], opts: { roleArn: g2.roleArn } });
  ok(p.grant === g2, "plan: opts.roleArn selects the named role from the granted set");
  ok(p.kind === "domain-role", "plan: a disambiguated selection is still a domain-role by default");

  throwsWith(
    () => plan({ grants: [g1, g2], opts: { roleArn: "arn:aws:iam::999999999999:role/not-granted" } }),
    "not granted to this scope",
    "plan: an un-granted roleArn is refused (selection cannot widen past the bundle grant)",
  );
}

{
  throwsWith(
    () => plan({ mode: "dm", actingPrincipalId: undefined, opts: { as: "user-sso" } }),
    "verified sender",
    "plan: user-sso on a routine fire (no acting sender) → refused (attended-human fence)",
  );

  throwsWith(
    () => plan({ mode: "channel", actingPrincipalId: "U_ALICE", opts: { as: "user-sso" } }),
    "only available in a DM",
    "plan: user-sso in a channel → refused (personal identity is DM-only)",
  );

  const p = plan({ mode: "dm", actingPrincipalId: "U_ALICE", domains: [], opts: { as: "user-sso" } });
  ok(p.kind === "user-sso", "plan: user-sso in an attended DM → user-sso identity");
  ok(p.principalId === "U_ALICE", "plan: user-sso carries the verified sender's principalId");
  ok(p.roleSessionName === awsRoleSessionName("U_ALICE"), "plan: user-sso RoleSessionName is the acting principal (not the domain)");
  ok(validSessionName(p.roleSessionName), "plan: user-sso RoleSessionName is a valid oe-… name");
}

{
  ok(awsRoleSessionName("payments") === "oe-payments", "sessionName: a clean label just gets the oe- prefix");
  ok(awsRoleSessionName("a.b@c+d=e,f") === "oe-a.b@c+d=e,f", "sessionName: the legal [\\w+=,.@-] chars are preserved");
  ok(awsRoleSessionName("pay/ments!") === "oe-pay-ments", "sessionName: illegal chars ('/', '!') become dashes");
  ok(awsRoleSessionName("--a  b--") === "oe-a-b", "sessionName: runs of dashes collapse and leading/trailing dashes are trimmed");
  ok(awsRoleSessionName("") === "oe-session", "sessionName: an empty label falls back to oe-session (non-empty)");
  ok(awsRoleSessionName("!!!") === "oe-session", "sessionName: an all-illegal label falls back to oe-session");

  const long = awsRoleSessionName("x".repeat(200));
  ok(long.length === 64, "sessionName: an over-long label is truncated to 64");
  ok(long.startsWith("oe-"), "sessionName: the oe- prefix survives truncation");
  ok(validSessionName(long), "sessionName: the truncated name is still valid AWS grammar");
}

{
  resetAwsIdentityProvider();
  throwsWith(
    () => requireAwsIdentityProvider(),
    "no AWS-identity provider is registered",
    "port: requireAwsIdentityProvider with none registered fails closed",
  );
  ok(awsIdentityProvider() === undefined, "port: awsIdentityProvider() is undefined when nothing is wired");

  resetAwsExecutor();
  throwsWith(
    () => requireAwsExecutor(),
    "no AWS executor is registered",
    "port: requireAwsExecutor with none registered fails closed",
  );
  ok(awsExecutor() === undefined, "port: awsExecutor() is undefined when nothing is wired");
}

const rec: { last?: AwsIdentityRequest; calls: number } = { calls: 0 };
const canned: AwsCredentials = {
  accessKeyId: "AKIA_FAKE",
  secretAccessKey: "fake-secret",
  sessionToken: "fake-session-token",
  expiresAtMs: 1_800_000_000_000,
};
const fakeProvider: AwsIdentityProvider = {
  async mint(req: AwsIdentityRequest): Promise<AwsCredentials> {
    rec.last = req;
    rec.calls++;
    return canned;
  },
};

try {
  registerAwsIdentityProvider(fakeProvider);
  ok(awsIdentityProvider() === fakeProvider, "port: after register, awsIdentityProvider() returns the registered provider");
  ok(requireAwsIdentityProvider() === fakeProvider, "port: requireAwsIdentityProvider() returns it too (no throw)");

  const fakeExecutor: AwsExecutor = {
    async run() {
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };
  registerAwsExecutor(fakeExecutor);
  try {
    ok(awsExecutor() === fakeExecutor, "port: after register, awsExecutor() returns the registered executor");
    ok(requireAwsExecutor() === fakeExecutor, "port: requireAwsExecutor() returns it too");
  } finally {
    resetAwsExecutor();
  }

  const opsBundle: Bundle = {
    name: "aws-ops",
    awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/oe-ops", region: "eu-west-2" }],
  };
  const opsBinding: Binding = { bundle: "aws-ops", scope: { level: "domain", domain: "ops" } };
  registerConfig({
    loadBundles: () => [opsBundle],
    loadBindings: () => [opsBinding],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => ["ops"],
  });

  const awsCtx: BindableContext = {
    channel: { kind: "local" },
    session: { auth: { current: { attributes: {}, principalId: "U_OPERATOR" } } },
  };

  rec.calls = 0;
  const resolved = await resolveAwsIdentity(awsCtx);
  ok(resolved.credentials === canned, "resolve: returns the provider's minted credentials");
  ok(resolved.roleArn === "arn:aws:iam::123456789012:role/oe-ops", "resolve: the resolved roleArn is the granted role");
  ok(resolved.region === "eu-west-2", "resolve: the granted region rides through");
  ok(resolved.boundAs === "domain-role", "resolve: a channel turn binds as the domain role");
  ok(resolved.roleSessionName === "oe-ops", "resolve: RoleSessionName is the oe-<domain> form");
  ok(rec.calls === 1, "resolve: the provider was minted exactly once");
  ok(rec.last?.kind === "domain-role", "resolve: the mint request carried kind domain-role");
  ok(rec.last?.roleArn === "arn:aws:iam::123456789012:role/oe-ops", "resolve: the mint request carried the granted roleArn");
  ok(rec.last?.roleSessionName === "oe-ops", "resolve: the mint request carried the derived RoleSessionName");
  ok(rec.last?.principalId === undefined, "resolve: a domain-role mint names no principalId");

  resetAwsIdentityProvider();
  await rejectsWith(
    () => resolveAwsIdentity(awsCtx),
    "no AWS-identity provider is registered",
    "resolve: with no provider wired, resolveAwsIdentity fails closed",
  );
} finally {
  resetAwsIdentityProvider();
}

{
  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: "not-an-arn" }] }]),
    "must be an IAM role ARN",
    "bundle-valid: a malformed roleArn is refused",
  );

  assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/x" }] }]);
  ok(true, "bundle-valid: a well-formed IAM role ARN passes");

  throwsWith(
    () =>
      assertBundlesValid([
        {
          name: "b",
          awsRoles: [
            { roleArn: "arn:aws:iam::123456789012:role/x" },
            { roleArn: "arn:aws:iam::123456789012:role/x" },
          ],
        },
      ]),
    "more than once",
    "bundle-valid: a duplicate roleArn within one bundle is refused",
  );

  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/x", region: "EU_WEST_2" }] }]),
    "not a well-formed AWS region",
    "bundle-valid: a malformed region is refused",
  );

  assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/x", region: "us-east-1" }] }]);
  ok(true, "bundle-valid: a well-formed region passes");

  assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: "arn:aws-us-gov:iam::123456789012:role/x", region: "us-gov-east-1" }] }]);
  ok(true, "bundle-valid: a gov-partition region (us-gov-east-1) passes");
}

{
  const roleShared = "arn:aws:iam::123456789012:role/oe-shared";
  const roleDomain = "arn:aws:iam::123456789012:role/oe-domain-only";

  const wide: Bundle = { name: "wide", awsRoles: [{ roleArn: roleShared, region: "us-east-1", audience: "aud-wide" }] };
  const narrow: Bundle = {
    name: "narrow",
    awsRoles: [
      { roleArn: roleShared, region: "eu-west-2", audience: "aud-narrow" },
      { roleArn: roleDomain, region: "eu-west-2" },
    ],
  };
  const bindings: Binding[] = [
    { bundle: "wide", scope: { level: "org" } },
    { bundle: "narrow", scope: { level: "domain", domain: "payments" } },
  ];
  const req: ResolveRequest = {
    mode: "channel",
    platform: "slack",
    workspace: "T1",
    channel: "C1",
    domains: ["payments"],
  };

  const eff = resolveAccess(req, [wide, narrow], bindings);
  ok(eff.awsRoles.length === 2, "union: two distinct roleArns after dedupe (the shared role granted twice collapses to one)");

  const shared = eff.awsRoles.find((g) => g.roleArn === roleShared);
  ok(shared !== undefined, "union: the shared role is present");
  ok(shared?.region === "eu-west-2" && shared?.audience === "aud-narrow", "union: the narrower (domain) grant overrides region/audience for the same roleArn (narrowest-wins)");
  ok(eff.awsRoles.some((g) => g.roleArn === roleDomain), "union: the domain-only role is added by the additive union");

  const effOrgOnly = resolveAccess({ ...req, domains: [] }, [wide, narrow], bindings);
  ok(effOrgOnly.awsRoles.length === 1 && effOrgOnly.awsRoles[0]!.roleArn === roleShared, "union: an unmatched domain binding contributes nothing (only the org grant resolves)");
  ok(effOrgOnly.awsRoles[0]!.region === "us-east-1", "union: with the domain binding out of scope, the org grant's own region stands");
}

console.log(`✓ aws-identity: ${passed} assertions passed`);
