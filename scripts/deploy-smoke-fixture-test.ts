import assert from "node:assert/strict";
import { linearSmokeSurfaceKey, linearSmokeTeamId, LINEAR_SMOKE_ORG } from "./deploy/linear-smoke-keys.js";

process.env.LINEAR_API_KEY = "linear-test-key";

await import("../agent/identity/surfaces.js");

const { loadDomains } = await import("../agent/memory/config/domains.js");
const { externalPolicyOverrideFor } = await import("@open-everywhere/core/agent/memory/domain.js");
const { resolveExternalPolicy } = await import("@open-everywhere/core/agent/access/external-policy.js");
const { declaredTrustForKeys } = await import("@open-everywhere/core/agent/identity/trust.js");
const { registerLinearProvider } = await import("@open-everywhere/provider-linear/agent/register.js");
registerLinearProvider();
const { linearExternalVerdict } = await import("@open-everywhere/provider-linear/agent/channels/linear.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const domains = loadDomains();

const roomVerdictFor = (surfaceKey: string): string =>
  linearExternalVerdict({ policy: resolveExternalPolicy(externalPolicyOverrideFor(surfaceKey, domains)), surfaceKey });

const tenantOf = (surfaceKey: string): string => surfaceKey.split("/").slice(0, 2).join("/");

const CLOCKS = [0, 1, 1_755_600_000_000, Date.now()];
for (const clock of CLOCKS) {
  const key = linearSmokeSurfaceKey(linearSmokeTeamId(clock));
  ok(
    roomVerdictFor(key) === "silent-room",
    `shipped config: the rung's surface key ${key} (clock ${clock}) resolves to verdict "silent-room" — the row deploy:smoke joins on`,
  );
}

const sampleKey = linearSmokeSurfaceKey(linearSmokeTeamId(Date.now()));
ok(
  externalPolicyOverrideFor(sampleKey, domains)?.roomGrain === "silent",
  `THE POLICY HALF: agent/memory/config/domains.ts "e2e-linear-signed-delivery" still declares externalPolicy.roomGrain "silent" over ${sampleKey}`,
);
ok(
  declaredTrustForKeys(tenantOf(sampleKey), sampleKey) === "public",
  `THE FACT HALF: agent/identity/surfaces.ts still declares ${sampleKey} trust "public" — without it roomGrain "silent" silences nothing and the live delivery runs a real model turn`,
);

const outsideGlob = `linear/${LINEAR_SMOKE_ORG}/not-a-smoke-team`;
ok(
  roomVerdictFor(outsideGlob) === "proceed",
  `negative control: ${outsideGlob} is in the scratch org but outside the glob, and resolves "proceed" — neither declaration is tenant-wide`,
);

const REAL_LINEAR_TEAM = "linear/1a000000-0000-4000-8000-000000000001/1a000000-0000-4000-8000-000000000011";
ok(
  roomVerdictFor(REAL_LINEAR_TEAM) === "proceed",
  `negative control: the operator's own vouched-internal Linear team resolves "proceed" — the scratch fixture reaches no live surface`,
);
ok(
  declaredTrustForKeys(tenantOf(REAL_LINEAR_TEAM), REAL_LINEAR_TEAM) === "internal",
  "negative control: that team is still declared INTERNAL, so assertion above is about the policy and not about an unregistered key",
);

console.log(`✓ deploy-smoke fixture: ${n} assertion(s) passed`);
