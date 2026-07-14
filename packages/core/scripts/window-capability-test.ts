import assert from "node:assert/strict";
import { TOOL_CONSEQUENCE, type ConsequenceTier } from "../agent/access/consequence.js";
import { defineDomain } from "../agent/memory/domain.js";
import { supervisorGrainFor } from "../agent/channels/unified-supervisor.js";
import { singleWindowMentionPolicy } from "../agent/channels/unified-window.js";
import { isVouchedInternal, registerTrustedSurfaces, _resetTrustedSurfacesForTest } from "../agent/identity/trust.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const noThrow = (fn: () => unknown, label: string) => {
  assert.doesNotThrow(fn, label);
  n++;
};
const todo = (label: string) => {
  console.log(`  · TODO (refactor-coupled, pends the gate): ${label}`);
};

const withWindowEnv = <T>(fn: () => T): T => {
  const prevU = process.env.OE_UNIFIED_SUPERVISOR;
  const prevW = process.env.OE_CROSS_SURFACE_WINDOW;
  process.env.OE_UNIFIED_SUPERVISOR = "1";
  process.env.OE_CROSS_SURFACE_WINDOW = "1";
  try {
    return fn();
  } finally {
    if (prevU === undefined) delete process.env.OE_UNIFIED_SUPERVISOR;
    else process.env.OE_UNIFIED_SUPERVISOR = prevU;
    if (prevW === undefined) delete process.env.OE_CROSS_SURFACE_WINDOW;
    else process.env.OE_CROSS_SURFACE_WINDOW = prevW;
  }
};

const FULL_CAPABILITY_TOOLS = ["checkout_repo", "bash", "web_fetch", "write_file", "open_pull_request", "post_file", "browser_qa", "create_skill", "create_routine"] as const;

const isMountedTier = (t: ConsequenceTier) => t === "open" || t === "gate:member";

console.log("P0-a — multi-source window CAN reach the full toolset (characterization):");

for (const name of FULL_CAPABILITY_TOOLS) {
  const entry = TOOL_CONSEQUENCE[name];
  ok(entry !== undefined, `[P0-a] full-capability tool "${name}" is registered (present on every session)`);
  ok(isMountedTier(entry.tier), `[P0-a] "${name}" is MOUNTED (tier=${entry?.tier}) — callable-in-principle from ANY session incl. a multi-source window`);
}
eq(TOOL_CONSEQUENCE.checkout_repo?.tier, "open", "[P0-a] checkout_repo is `open` (auto-approved) on EVERY session — the permissive reality the refactor narrows for multi-source windows");

withWindowEnv(() => {
  const SLACK = "slack/T1/C_PAY";
  const GH = "github/acme/payments-api";
  const orgGate = defineDomain({ name: "org", match: "org", unifiedSupervisorGate: true, crossSurfaceWindowGate: true });
  const multiSourceWindow = defineDomain({
    name: "payments",
    channels: [SLACK, GH],
    ambientSupervisor: true,
    unifiedSupervisor: true,
    crossSurfaceWindow: true,
  });
  const grain = supervisorGrainFor(SLACK, [multiSourceWindow, orgGate]);
  ok(grain.unified === true && grain.singleWindow === true, "[P0-a] a 2-source crossSurfaceWindow domain resolves a single-window supervisor grain");
  const keys = Object.keys(grain).sort();
  eq(keys, ["domainName", "registryKey", "singleWindow", "unified"], "[P0-a] the window grain carries NO tool-narrowing field today (topology is resolved, tools are not touched)");
});

console.log("P0-d — vouch is runtime today; config-validation twin staged:");

_resetTrustedSurfacesForTest();
registerTrustedSurfaces(["slack/T1/C_VOUCHED"]);
{
  const vouched = isVouchedInternal("slack/T1", "slack/T1/C_VOUCHED");
  const unvouched = isVouchedInternal("slack/T1", "slack/T1/C_OPEN");
  ok(vouched === true, "[P0-d] a registered surface is vouched-internal (privacyOk source)");
  ok(unvouched === false, "[P0-d] an unregistered surface is NOT vouched — fail-closed");

  const admitted = singleWindowMentionPolicy(true, true, vouched);
  eq(admitted, { suppressNative: true, addressing: "direct-mention" }, "[P0-d] vouched single-window mention ⇒ ADMITTED to the window (native suppressed, addressed)");
  const refused = singleWindowMentionPolicy(true, true, unvouched);
  eq(refused, { suppressNative: false, addressing: undefined }, "[P0-d] UN-vouched single-window mention ⇒ NOT admitted (native keeps the mention) — the runtime vouch");
}
_resetTrustedSurfacesForTest();

{
  const orgGate = defineDomain({ name: "org", match: "org", unifiedSupervisorGate: true, crossSurfaceWindowGate: true });
  const multiSourceUnvouched = defineDomain({
    name: "payments",
    channels: ["slack/T1/C_VOUCHED", "github/acme/secret"],
    ambientSupervisor: true,
    unifiedSupervisor: true,
    crossSurfaceWindow: true,
  });
  const domainMod: Record<string, unknown> = await import("../agent/memory/domain.js");
  const assertUnifiedDomainTrust = domainMod.assertUnifiedDomainTrust as (d: readonly unknown[]) => void;
  noThrow(
    () => assertUnifiedDomainTrust([multiSourceUnvouched, orgGate] as never),
    "[P0-d] TODAY: assertUnifiedDomainTrust does NOT throw on an unvouched source in a multi-source window (config-load vouch gap)",
  );

  const assertWindowSourcesVouched = domainMod.assertWindowSourcesVouched as
    | ((d: readonly unknown[], vouched: readonly string[]) => void)
    | undefined;
  if (typeof assertWindowSourcesVouched === "function") {
    assert.throws(
      () => assertWindowSourcesVouched([multiSourceUnvouched, orgGate] as never, ["slack/T1/C_VOUCHED"]),
      /github\/acme\/secret/,
      "[P0-d] multi-source window with an unvouched source throws at config load",
    );
    n++;
    const soloUnvouched = defineDomain({
      name: "solo",
      channels: ["github/acme/secret"],
      ambientSupervisor: true,
      unifiedSupervisor: true,
      crossSurfaceWindow: true,
    });
    assert.doesNotThrow(() => assertWindowSourcesVouched([soloUnvouched, orgGate] as never, []), "[P0-d] a SOLO window over the same unvouched source does NOT throw (vouch gates multi-source only)");
    n++;
  } else {
    todo("assertWindowSourcesVouched not yet built — multi-source-unvouched-throws / solo-of-same-does-not twin pends the config-validation code");
  }
}

console.log("P1-c — native-DM full-capability golden (pre-fold baseline):");

eq(singleWindowMentionPolicy(false, true, true), { suppressNative: false, addressing: undefined }, "[P1-c] non-window session: native handler OWNS the mention (full-capability path)");
eq(singleWindowMentionPolicy(false, false, true), { suppressNative: false, addressing: undefined }, "[P1-c] non-window ambient: unchanged (native split)");

const NATIVE_DM_CAPABILITY_GOLDEN: Readonly<Record<string, ConsequenceTier>> = {
  checkout_repo: "open",
  bash: "open",
  web_fetch: "open",
  write_file: "open",
  post_file: "open",
  browser_qa: "open",
  open_pull_request: "gate:member",
  create_skill: "gate:member",
  create_routine: "gate:member",
};
const nativeActual: Record<string, ConsequenceTier> = {};
for (const name of Object.keys(NATIVE_DM_CAPABILITY_GOLDEN)) {
  const entry = TOOL_CONSEQUENCE[name];
  ok(entry !== undefined, `[P1-c] native session mounts "${name}"`);
  nativeActual[name] = entry.tier;
}
eq(nativeActual, NATIVE_DM_CAPABILITY_GOLDEN, "[P1-c] native-DM full-capability golden — the pre-fold set the post-fold solo-window session must match byte-for-byte");

console.log(`\nwindow-capability: ${n} assertions passed.`);
