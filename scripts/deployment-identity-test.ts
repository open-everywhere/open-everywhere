import { assertCoreDistFresh } from "./core-dist-freshness.js";

assertCoreDistFresh();

const RETIRED = ["OE_ORG", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL"] as const;
for (const name of RETIRED) process.env[name] = `env-${name}-must-be-ignored`;

const { deploymentIdentity } = await import("../agent/identity/surfaces.js");
const {
  deploymentOrg,
  ambientWorkspace,
  ambientSurface,
  registerDeploymentIdentity,
  _resetDeploymentIdentityForTest,
} = await import("@open-everywhere/core/agent/identity/deployment-identity.js");
const { bindFrom } = await import("@open-everywhere/core/agent/identity/binding.js");
const { ENV_READ_ALLOWLIST } = await import("./env-read-allowlist.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  n++;
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
};

ok(deploymentOrg() === deploymentIdentity.org, "the org is the one agent/identity/surfaces.ts declares");
ok(ambientWorkspace() === deploymentIdentity.workspace, "the ambient workspace is the declared one");
ok(ambientSurface() === deploymentIdentity.surface, "the ambient surface is the declared one");
for (const name of RETIRED) {
  ok(
    deploymentOrg() !== process.env[name] &&
      ambientWorkspace() !== process.env[name] &&
      ambientSurface() !== process.env[name],
    `🔴 no value came from ${name} — the env carries a different string and nothing read it`,
  );
}

{
  const local = bindFrom({});
  ok(local.platform === "local", "a context with no platform identity binds `local`");
  ok(local.workspace === deploymentIdentity.workspace, "the bound workspace agrees with the declaration");
  ok(local.surface === deploymentIdentity.surface, "the bound surface agrees with the declaration");
  ok(local.org === deploymentOrg(), "the binding is stamped with the declared org");
}

{
  registerDeploymentIdentity({ org: "oe1545org", workspace: "oe1545ws", surface: "oe1545room" });
  const declared = bindFrom({});
  ok(
    declared.workspace === "oe1545ws",
    "🔴 boot with the env vars unset (and poisoned) resolves the ambient WORKSPACE from config",
  );
  ok(
    declared.surface === "oe1545room",
    "🔴 boot with the env vars unset (and poisoned) resolves the ambient SURFACE from config",
  );
  ok(declared.org === "oe1545org", "🔴 …and the binding's org is the declared one, not the poisoned OE_ORG");
  registerDeploymentIdentity(deploymentIdentity);
}

{
  const { carriesPlatformIdentity } = await import("@open-everywhere/core/agent/identity/binding.js");
  ok(ambientSurface() !== undefined, "precondition: this deployment DOES declare an ambient room");
  ok(
    !carriesPlatformIdentity({}),
    "🔴 a declared ambient room does NOT make an identity-less context carry a platform identity",
  );
}

{
  registerDeploymentIdentity({ org: "other-org", workspace: "other-ws", surface: "other-room" });
  const moved = bindFrom({});
  ok(moved.workspace === "other-ws", "a changed declaration moves the bound workspace");
  ok(moved.surface === "other-room", "a changed declaration moves the bound surface");
  ok(deploymentOrg() === "other-org", "a changed declaration moves the org");
  ok(moved.org === "other-org", "…and the binding is stamped with it");
}

{
  _resetDeploymentIdentityForTest();
  ok(ambientWorkspace() === undefined, "an unregistered deployment declares no ambient workspace");
  ok(ambientSurface() === undefined, "an unregistered deployment declares no ambient surface");
  ok(deploymentOrg() === "default", "an unregistered deployment's org is the shipped \"default\"");
  const bare = bindFrom({});
  ok(bare.workspace === "dev", "the binding falls back to UNNAMED_TENANT, not to OE_WORKSPACE");
  ok(bare.surface === "default", "the binding falls back to \"default\", not to OE_SURFACE");
  ok(bare.org === "default", "the binding's org falls back to \"default\", not to OE_ORG");
  registerDeploymentIdentity(deploymentIdentity);
}

for (const name of RETIRED) {
  ok(!ENV_READ_ALLOWLIST.has(name), `${name} holds no env-read-allowlist row any more`);
}

console.log(`\n${n} assertions passed`);
