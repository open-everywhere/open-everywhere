process.env.OE_MODE = "dm";

import {
  registerAwsSsoLinkStore,
  resetAwsSsoLinkStore,
  awsSsoLinkStore,
  requireAwsSsoLinkStore,
  type AwsSsoLinkStore,
} from "../agent/connections/aws-sso-link.js";
import {
  resolveAwsIdentity,
  registerAwsIdentityProvider,
  resetAwsIdentityProvider,
  type AwsCredentials,
  type AwsIdentityProvider,
  type AwsIdentityRequest,
} from "../agent/connections/aws-identity.js";
import { registerConfig } from "../agent/access/config.js";
import type { Binding, Bundle } from "../agent/access/bundle.js";
import { deploymentOrg, type BindableContext } from "../agent/identity/binding.js";
import { rawVaultSubject } from "../agent/identity/oauth-vault-share.js";

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

{
  resetAwsSsoLinkStore();
  ok(awsSsoLinkStore() === undefined, "port: awsSsoLinkStore() is undefined when nothing is wired");
  throwsWith(
    () => requireAwsSsoLinkStore(),
    "no AWS-SSO link store is registered",
    "port: requireAwsSsoLinkStore with none registered fails closed",
  );

  const rows = new Map<string, string>();
  const fake: AwsSsoLinkStore = {
    async read(principalSubject) {
      return rows.has(principalSubject) ? rows.get(principalSubject)! : null;
    },
    async write(principalSubject, token) {
      rows.set(principalSubject, token);
    },
    async clear(principalSubject) {
      rows.delete(principalSubject);
    },
  };

  registerAwsSsoLinkStore(fake);
  ok(awsSsoLinkStore() === fake, "port: after register, awsSsoLinkStore() returns the registered store");
  ok(requireAwsSsoLinkStore() === fake, "port: requireAwsSsoLinkStore() returns it too (no throw)");

  const aliceSlack = rawVaultSubject("acme", "slack", "T1", "U_ALICE");
  ok((await requireAwsSsoLinkStore().read(aliceSlack)) === null, "store: an unlinked principal reads null");
  await requireAwsSsoLinkStore().write(aliceSlack, "opaque-token-blob-alice");
  ok((await requireAwsSsoLinkStore().read(aliceSlack)) === "opaque-token-blob-alice", "store: a written token round-trips for that principal");
  ok((await requireAwsSsoLinkStore().read(rawVaultSubject("acme", "slack", "T1", "U_BOB"))) === null, "store: a DIFFERENT principal is unaffected (keyed strictly on the subject)");

  ok((await requireAwsSsoLinkStore().read(rawVaultSubject("other-org", "slack", "T1", "U_ALICE"))) === null, "store: 🔴 the SAME native id in ANOTHER ORG reads null — no cross-org alias onto a linked AWS session");
  ok((await requireAwsSsoLinkStore().read(rawVaultSubject("acme", "discord", undefined, "U_ALICE"))) === null, "store: 🔴 the SAME native id on ANOTHER PLATFORM reads null — no cross-vendor alias (digit-string ids collide across namespaces)");
  ok((await requireAwsSsoLinkStore().read("U_ALICE")) === null, "store: 🔴 the PRE-OPE-286 bare-id key resolves nothing — old rows ORPHAN (re-consent), and there is no fallback read that would re-open the collision");

  await requireAwsSsoLinkStore().clear(aliceSlack);
  ok((await requireAwsSsoLinkStore().read(aliceSlack)) === null, "store: clear() forgets the principal's link");

  resetAwsSsoLinkStore();
  throwsWith(() => requireAwsSsoLinkStore(), "no AWS-SSO link store is registered", "port: reset returns to the fail-closed state");
}

{
  const opsBundle: Bundle = { name: "aws-ops", awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/oe-ops", region: "eu-west-2", allow: ["*"] }] };
  const opsBinding: Binding = { bundle: "aws-ops", scope: { level: "principal", principal: "local/U_ALICE" } };
  registerConfig({
    loadBundles: () => [opsBundle],
    loadBindings: () => [opsBinding],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  const dmCtx: BindableContext = {
    channel: { kind: "local" },
    session: { auth: { current: { attributes: {}, principalId: "U_ALICE" } } },
  };

  const canned: AwsCredentials = { accessKeyId: "ASIA_SSO", secretAccessKey: "sso-secret", sessionToken: "sso-session", expiresAtMs: 1_900_000_000_000 };

  {
    const rec: { last?: AwsIdentityRequest; calls: number } = { calls: 0 };
    const linkedProvider: AwsIdentityProvider = {
      async mint(req) {
        rec.last = req;
        rec.calls++;
        return canned;
      },
    };
    registerAwsIdentityProvider(linkedProvider);
    try {
      const resolved = await resolveAwsIdentity(dmCtx, { as: "user-sso" });
      ok(resolved.credentials === canned, "user-sso linked: resolveAwsIdentity returns the provider's minted creds");
      ok(resolved.boundAs === "user-sso", "user-sso linked: bound as user-sso");
      ok(resolved.roleArn === "arn:aws:iam::123456789012:role/oe-ops", "user-sso linked: the granted roleArn rides through");
      ok(resolved.roleSessionName === "oe-U_ALICE", "user-sso linked: RoleSessionName is the acting principal (not the domain)");
      ok(rec.calls === 1, "user-sso linked: the provider was minted exactly once");
      ok(rec.last?.kind === "user-sso", "user-sso linked: the mint request carried kind user-sso");
      ok(rec.last?.roleArn === "arn:aws:iam::123456789012:role/oe-ops", "user-sso linked: the mint request carried the granted roleArn");

      const expected = rawVaultSubject(deploymentOrg(), "local", undefined, "U_ALICE");
      ok(rec.last?.principalSubject === expected, "user-sso linked: the mint request carried the QUALIFIED subject composed from the binding's own org + platform");
      ok(rec.last?.principalSubject !== "U_ALICE", "user-sso linked: 🔴 NOT the bare native id — that is the spelling that let two humans share one AWS session row");
      ok(rec.last?.org === deploymentOrg(), "user-sso linked: the request also carries the org outright (the adapter's warm-cache key is org-scoped for both kinds)");
      ok(resolved.roleSessionName === "oe-U_ALICE" && rec.last?.principalSubject !== resolved.roleSessionName, "user-sso linked: the attribution label and the vault key are distinct derivations of the same human");
    } finally {
      resetAwsIdentityProvider();
    }
  }

  {
    const url = "https://oidc.eu-west-2.amazonaws.com/authorize?client_id=oe&state=xyz";
    class LinkRequired extends Error {
      readonly code = "aws_sso_link_required";
      readonly authorizationUrl = url;
      constructor() {
        super(`your AWS account isn't linked yet — open this link: ${url}`);
        this.name = "AwsSsoLinkRequiredError";
      }
    }
    const unlinkedProvider: AwsIdentityProvider = {
      async mint() {
        throw new LinkRequired();
      },
    };
    registerAwsIdentityProvider(unlinkedProvider);
    try {
      await rejectsWith(() => resolveAwsIdentity(dmCtx, { as: "user-sso" }), url, "user-sso unlinked: the authorization URL is propagated to the caller");
      let caught: unknown;
      try {
        await resolveAwsIdentity(dmCtx, { as: "user-sso" });
      } catch (e) {
        caught = e;
      }
      ok((caught as { code?: string })?.code === "aws_sso_link_required", "user-sso unlinked: the error keeps its aws_sso_link_required code (classifiable)");
      ok((caught as { authorizationUrl?: string })?.authorizationUrl === url, "user-sso unlinked: the error carries the authorizationUrl property");
    } finally {
      resetAwsIdentityProvider();
    }
  }
}

console.log(`✓ aws-sso-link: ${passed} assertions passed (link-store port fail-closed + roundtrip; user-sso resolver linked vs unlinked)`);
