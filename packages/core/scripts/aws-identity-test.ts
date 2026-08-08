import {
  awsRoleSessionName,
  isAwsCommandAllowed,
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
import { rawVaultSubject } from "../agent/identity/oauth-vault-share.js";
import { assertBundlesValid, type AwsRoleGrant, type Binding, type Bundle } from "../agent/access/bundle.js";
import { awsCommandVerdict, awsSessionPolicyFromAllow } from "../agent/access/aws-screen.js";
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

const g1: AwsRoleGrant = { roleArn: "arn:aws:iam::123456789012:role/oe-payments", region: "eu-west-2", allow: ["*"] };
const g2: AwsRoleGrant = { roleArn: "arn:aws:iam::123456789012:role/oe-readonly", allow: ["*"] };

function plan(over: Partial<Parameters<typeof planAwsIdentity>[0]> = {}) {
  return planAwsIdentity({
    grants: [g1],
    mode: "channel",
    actingPrincipalId: undefined,
    org: "acme",
    platform: "slack",
    workspace: "T1",
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
  ok(p.principalSubject === undefined, "plan: a domain-role plan names no principal subject (it is not a person's identity)");
  ok(p.org === "acme", "plan: the org rides onto the plan for BOTH kinds — the adapter's cache key is org-scoped even with nobody named (OPE-286)");
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
  ok(p.roleSessionName === awsRoleSessionName("U_ALICE"), "plan: user-sso RoleSessionName is the acting principal (not the domain)");
  ok(validSessionName(p.roleSessionName), "plan: user-sso RoleSessionName is a valid oe-… name");

  ok(p.principalSubject === rawVaultSubject("acme", "slack", "T1", "U_ALICE"), "plan: user-sso carries the ONE composer's qualified subject for the verified sender");
  ok(p.principalSubject !== "U_ALICE", "plan: 🔴 the subject is NOT the bare native id — that spelling is what OPE-286 deleted");
  ok(p.principalSubject!.startsWith("p:") && p.principalSubject!.includes("/slack/T1/"), "plan: the subject carries its namespace prefix + the platform from the BINDING (never sniffed from the id)");
  ok(p.org === "acme", "plan: the user-sso plan carries the org too (the adapter's cache key is org-scoped for both kinds)");

  ok(p.roleSessionName !== p.principalSubject, "plan: the CloudTrail label and the vault key are DISTINCT derivations — a label never addresses a credential row");

  const other = plan({ mode: "dm", actingPrincipalId: "U_ALICE", org: "other", domains: [], opts: { as: "user-sso" } });
  ok(other.principalSubject !== p.principalSubject, "plan: same native id, DIFFERENT org → a different vault subject (no cross-org alias)");
  const otherPlatform = plan({ mode: "dm", actingPrincipalId: "U_ALICE", platform: "discord", domains: [], opts: { as: "user-sso" } });
  ok(otherPlatform.principalSubject !== p.principalSubject, "plan: same native id, DIFFERENT platform → a different vault subject (no cross-vendor alias)");
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
    awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/oe-ops", region: "eu-west-2", allow: ["logs", "s3:cp"] }],
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
  ok(
    JSON.stringify(resolved.allow) === JSON.stringify(["logs", "s3:cp"]),
    "resolve: the VERIFIED grant's `allow` list rides onto ResolvedAwsIdentity (Phase 2 host-side narrowing)",
  );
  ok(rec.calls === 1, "resolve: the provider was minted exactly once");
  ok(rec.last?.kind === "domain-role", "resolve: the mint request carried kind domain-role");
  ok(rec.last?.roleArn === "arn:aws:iam::123456789012:role/oe-ops", "resolve: the mint request carried the granted roleArn");
  ok(rec.last?.roleSessionName === "oe-ops", "resolve: the mint request carried the derived RoleSessionName");
  ok(rec.last?.principalSubject === undefined, "resolve: a domain-role mint names no principal subject");
  ok(typeof rec.last?.org === "string" && rec.last.org.length > 0, "resolve: the domain-role mint carries the org — its cache key cannot be composed by a second tenant with a same-named domain");
  ok(typeof rec.last?.sessionPolicy === "string", "resolve: the domain-role mint carries the compiled STS session policy");
  {
    const acts = (JSON.parse(rec.last!.sessionPolicy!) as { Statement: { Action: string[] }[] }).Statement[0]!.Action;
    ok(acts.includes("logs:*") && acts.includes("s3:GetObject"), "resolve: the session policy is the grant's own allow grammar, compiled");
  }
  ok(resolved.domain === "ops", "resolve: the PLAN's domain rides onto ResolvedAwsIdentity — the audit row's `channel/domain` half (aws-access-plan.md §9), carried out rather than re-derived so it cannot disagree with the RoleSessionName");

  const fireCtx: BindableContext = {
    channel: { kind: "local" },
    session: {
      auth: {
        current: {
          principalType: "service",
          principalId: "U_ROUTINE_CREATOR",
          attributes: { oe_fire_principal: "U_ROUTINE_CREATOR", oe_fire_unattended: "true" },
        },
      },
    },
  };
  registerAwsIdentityProvider(fakeProvider);
  rec.calls = 0;
  await rejectsWith(
    () => resolveAwsIdentity(fireCtx, { as: "user-sso" }),
    "acting as your AWS SSO identity needs a verified sender on this turn",
    "fire-path: 🔴 a routine fire may NOT assume a human's SSO identity — the attended-human fence survives the ctx→plan wiring, not just the pure call",
  );
  ok(rec.calls === 0, "fire-path: …and it refused BEFORE minting — no credential is ever created for an identity the fire may not have");

  const fireResolved = await resolveAwsIdentity(fireCtx);
  ok(fireResolved.boundAs === "domain-role", "fire-path: the DEFAULT path still works for a fire — running under the domain's service role is shipped design intent, not an oversight");
  ok(rec.last?.principalSubject === undefined, "fire-path: …and that mint names NO principal subject, so nothing downstream can read a borrowed human out of it");
  ok(rec.last?.roleSessionName === "oe-ops", "fire-path: the RoleSessionName is the DOMAIN's, so CloudTrail attributes the call to the service identity rather than to a person who was not there");

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
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: "not-an-arn", allow: ["*"] }] }]),
    "must be an IAM role ARN",
    "bundle-valid: a malformed roleArn is refused",
  );

  assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/x", allow: ["*"] }] }]);
  ok(true, "bundle-valid: a well-formed IAM role ARN passes");

  throwsWith(
    () =>
      assertBundlesValid([
        {
          name: "b",
          awsRoles: [
            { roleArn: "arn:aws:iam::123456789012:role/x", allow: ["*"] },
            { roleArn: "arn:aws:iam::123456789012:role/x", allow: ["*"] },
          ],
        },
      ]),
    "more than once",
    "bundle-valid: a duplicate roleArn within one bundle is refused",
  );

  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/x", region: "EU_WEST_2", allow: ["*"] }] }]),
    "not a well-formed AWS region",
    "bundle-valid: a malformed region is refused",
  );

  assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/x", region: "us-east-1", allow: ["*"] }] }]);
  ok(true, "bundle-valid: a well-formed region passes");

  assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: "arn:aws-us-gov:iam::123456789012:role/x", region: "us-gov-east-1", allow: ["*"] }] }]);
  ok(true, "bundle-valid: a gov-partition region (us-gov-east-1) passes");
}

{
  const ROLE = "arn:aws:iam::123456789012:role/x";

  assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: ROLE, allow: ["logs", "s3:cp", "dynamodb:query"] }] }]);
  ok(true, "bundle-valid: a well-formed allow list (service + service:operation) passes");
  assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: ROLE, allow: ["logs:Describe*", "s3:GetObject", "*"] }] }]);
  ok(true, "bundle-valid: IAM-native glob entries and the explicit unrestricted `*` pass");

  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: ROLE, allow: [] }] }]),
    "REQUIRED",
    "bundle-valid: an EMPTY allow list is refused — unrestricted must be spelled [\"*\"] explicitly",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: ROLE } as unknown as AwsRoleGrant] }]),
    "REQUIRED",
    "bundle-valid: an ABSENT allow list (a JS config dodging the type) is refused the same way",
  );

  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: ROLE, allow: ["logs", "  "] }] }]),
    "empty/whitespace",
    "bundle-valid: an empty/whitespace allow entry is refused",
  );

  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: ROLE, allow: ["s3:cp:extra"] }] }]),
    "at most one",
    "bundle-valid: an allow entry with more than one ':' is refused",
  );

  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: ROLE, allow: ["s3:"] }] }]),
    "both sides",
    "bundle-valid: an allow entry with an empty operation half is refused",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: ROLE, allow: [":cp"] }] }]),
    "both sides",
    "bundle-valid: an allow entry with an empty service half is refused",
  );

  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: ROLE, allow: ["s3:cp", "S3:cp"] }] }]),
    "more than once",
    "bundle-valid: a duplicate allow entry (case-insensitive) within one grant is refused",
  );
  throwsWith(
    () => assertBundlesValid([{ name: "b", awsRoles: [{ roleArn: ROLE, allow: ["logs:start-query", "logs:start_query"] }] }]),
    "more than once",
    "bundle-valid: a duplicate allow entry (`-`/`_` equivalent) is refused",
  );
}

{
  ok(!isAwsCommandAllowed(["logs", "start-query"], undefined), "allow: undefined allow ⇒ REFUSED (unrestricted must be [\"*\"])");
  ok(!isAwsCommandAllowed(["s3", "rm", "--recursive"], []), "allow: empty allow ⇒ REFUSED");
  ok(isAwsCommandAllowed(["s3", "rm", "x"], ["*"]), "allow: the explicit [\"*\"] is unrestricted");

  ok(!isAwsCommandAllowed(["configure", "export-credentials"], ["*"]), "fence1: `configure export-credentials` refused under [\"*\"]");
  ok(!isAwsCommandAllowed(["configure", "list"], ["*"]), "fence1: `configure list` refused under [\"*\"]");
  ok(!isAwsCommandAllowed(["logs", "describe-log-groups", "--debug"], ["*"]), "fence1: `--debug` refused anywhere in argv (prints the credential chain)");
  {
    const v = awsCommandVerdict({ argv: ["configure", "export-credentials"], allow: ["*"] });
    ok(!v.ok && v.code === "credential-read", "fence1: the verdict carries the closed reason code credential-read");
  }

  ok(
    !isAwsCommandAllowed(["logs", "--endpoint-url", "https://attacker/", "describe-log-groups"], ["logs"]),
    "fence2: 🔴 the --endpoint-url defeat is DEAD — the whole argv is screened, not args[0..1]",
  );
  ok(!isAwsCommandAllowed(["logs", "describe-log-groups", "--endpoint-url=https://attacker/"], ["logs"]), "fence2: the --opt=value form is refused too");
  ok(!isAwsCommandAllowed(["s3", "cp", "a", "b", "--no-verify-ssl"], ["*"]), "fence2: --no-verify-ssl refused (TLS defeat)");
  ok(!isAwsCommandAllowed(["s3", "cp", "a", "b", "--ca-bundle", "/tmp/x"], ["*"]), "fence2: --ca-bundle refused (spoofed endpoint trust)");
  ok(!isAwsCommandAllowed(["logs", "describe-log-groups", "--profile", "prod"], ["*"]), "fence2: --profile refused (ambient identity)");
  ok(!isAwsCommandAllowed(["s3api", "get-object", "--bucket", "b", "--key", "k", "--outfile", "/etc/x"], ["*"]), "fence2: --outfile refused (host write)");
  ok(!isAwsCommandAllowed(["dynamodb", "put-item", "--item", "file:///etc/passwd"], ["*"]), "fence2: a file:// value refused anywhere in argv (host read)");
  {
    const v = awsCommandVerdict({ argv: ["logs", "--endpoint-url", "https://x/", "describe-log-groups"], allow: ["logs"] });
    ok(!v.ok && v.code === "argv-option", "fence2: the verdict carries the closed reason code argv-option");
  }

  ok(isAwsCommandAllowed(["logs", "describe-log-groups"], ["logs:Describe*"]), "grammar: an IAM-native glob (logs:Describe*) matches the CLI kebab op");
  ok(!isAwsCommandAllowed(["logs", "start-query"], ["logs:Describe*"]), "grammar: …and refuses ops outside the glob");
  ok(isAwsCommandAllowed(["logs", "start-query"], ["logs:StartQuery"]), "grammar: an exact IAM-native name matches its kebab CLI spelling (kebab→Pascal is mechanical)");
  ok(isAwsCommandAllowed(["s3api", "get-object", "--bucket", "b", "--key", "k"], ["s3:GetObject"]), "grammar: the s3api CLI service maps to the s3 IAM prefix");
  ok(isAwsCommandAllowed(["dynamodb", "query"], ["*:Query"]), "grammar: a service-glob entry (*:Query) matches across services");
  ok(!isAwsCommandAllowed(["s3", "cp", "a", "b"], ["s3:GetObject"]), "fanout: s3 cp refused on a Get-only grant (it also needs PutObject+ListBucket)");
  ok(isAwsCommandAllowed(["s3", "cp", "a", "b"], ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]), "fanout: s3 cp allowed when every fanned-out action is covered");
  ok(isAwsCommandAllowed(["s3", "ls"], ["s3:List*"]), "fanout: s3 ls allowed by a List* glob");
  ok(!isAwsCommandAllowed(["s3", "rm", "x"], ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]), "fanout: s3 rm refused without DeleteObject");

  ok(isAwsCommandAllowed(["logs", "start-query"], ["logs"]), "allow: bare-service entry allows any op of that service");
  ok(isAwsCommandAllowed(["logs", "describe-log-groups"], ["logs"]), "allow: bare-service entry allows a different op of the same service");
  ok(!isAwsCommandAllowed(["s3", "cp"], ["logs"]), "allow: a command whose service is not listed is refused");

  ok(isAwsCommandAllowed(["s3", "cp", "a", "b"], ["s3:cp"]), "allow: service:operation entry allows exactly that op");
  ok(!isAwsCommandAllowed(["s3", "rm"], ["s3:cp"]), "allow: service:operation entry refuses a different op of the same service");
  ok(!isAwsCommandAllowed(["logs", "cp"], ["s3:cp"]), "allow: service:operation entry refuses the same op on a different service");

  ok(isAwsCommandAllowed(["LOGS", "Start-Query"], ["logs:start-query"]), "allow: service + operation match case-insensitively");
  ok(isAwsCommandAllowed(["logs", "start_query"], ["logs:start-query"]), "allow: operation matches with `_` treated as `-`");
  ok(isAwsCommandAllowed(["logs", "start-query"], ["logs:start_query"]), "allow: the reverse `-`/`_` tolerance also holds");
  ok(isAwsCommandAllowed(["S3", "cp"], ["s3"]), "allow: bare-service match is case-insensitive too");

  ok(isAwsCommandAllowed(["s3", "cp"], ["logs", "s3:cp"]), "allow: allowed when one of several entries matches");
  ok(!isAwsCommandAllowed(["dynamodb", "scan"], ["logs", "s3:cp"]), "allow: refused when no entry matches");

  ok(!isAwsCommandAllowed(["s3"], ["s3:cp"]), "allow: a service:operation entry does not match a command with no operation");
  ok(isAwsCommandAllowed(["s3"], ["s3"]), "allow: a bare-service entry matches a command with no operation");
}

{
  ok(awsSessionPolicyFromAllow(["*"]) === undefined, "policy: [\"*\"] compiles to NO session policy (explicitly unrestricted — nothing to narrow)");
  ok(awsSessionPolicyFromAllow([]) === undefined, "policy: an (invalid) empty list compiles to nothing — the screen refuses it anyway");

  const compiled = awsSessionPolicyFromAllow(["logs", "s3:cp", "dynamodb:Query"]);
  ok(compiled !== undefined, "policy: a compilable grammar produces a policy document");
  const doc = JSON.parse(compiled!) as { Version: string; Statement: { Effect: string; Action: string[]; Resource: string }[] };
  ok(doc.Version === "2012-10-17" && doc.Statement[0]!.Effect === "Allow", "policy: standard IAM document shape");
  const actions = doc.Statement[0]!.Action;
  ok(actions.includes("logs:*"), "policy: a bare service compiles to service:*");
  ok(actions.includes("s3:GetObject") && actions.includes("s3:PutObject") && actions.includes("s3:ListBucket"), "policy: the s3 cp CLI entry compiles to its enumerated fan-out");
  ok(actions.includes("dynamodb:Query"), "policy: an IAM-native entry passes through unchanged");

  const kebab = awsSessionPolicyFromAllow(["logs:start-query", "logs:describe-*"]);
  const kebabActions = (JSON.parse(kebab!) as { Statement: { Action: string[] }[] }).Statement[0]!.Action;
  ok(kebabActions.includes("logs:StartQuery") && kebabActions.includes("logs:Describe*"), "policy: kebab CLI entries translate to Pascal (globs survive)");

  ok(awsSessionPolicyFromAllow(["logs", "*:Get*"]) === undefined, "policy: any uncompilable entry declines the WHOLE policy (a partial intersection would break allowed commands)");
}

{
  const roleShared = "arn:aws:iam::123456789012:role/oe-shared";
  const roleDomain = "arn:aws:iam::123456789012:role/oe-domain-only";

  const wide: Bundle = { name: "wide", awsRoles: [{ roleArn: roleShared, region: "us-east-1", audience: "aud-wide", allow: ["*"] }] };
  const narrow: Bundle = {
    name: "narrow",
    awsRoles: [
      { roleArn: roleShared, region: "eu-west-2", audience: "aud-narrow", allow: ["logs"] },
      { roleArn: roleDomain, region: "eu-west-2", allow: ["*"] },
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
