import assert from "node:assert/strict";
import {
  defineSurface,
  registerSurfaces,
  _resetSurfacesForTest,
  isVouchedInternal,
  isVouchedSurface,
  vouchedSurfaces,
  type Surface,
} from "../agent/identity/trust.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const throws = (fn: () => unknown, label: string) => {
  assert.throws(fn, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

{
  ok(
    defineSurface({ key: "discord/G1", trust: "internal" }).key === "discord/G1",
    "defineSurface: a well-formed workspaceKey builds",
  );
  ok(
    defineSurface({ key: "discord/G1/C1", trust: "internal" }).trust === "internal",
    "defineSurface: a well-formed surfaceKey builds and carries its trust",
  );
  ok(
    defineSurface({ key: "teams/7e5a0000-74bc/19-abc-thread.tacv2", trust: "internal" }).key.length > 0,
    "defineSurface: a surface segment with dots/dashes is well-formed (3 segments)",
  );
  throws(() => defineSurface({ key: "discord", trust: "internal" }), "defineSurface: a bare platform (1 segment) is malformed");
  throws(() => defineSurface({ key: "a/b/c/d", trust: "internal" }), "defineSurface: a 4-segment key is malformed");
  throws(() => defineSurface({ key: "a//b", trust: "internal" }), "defineSurface: an empty middle segment is malformed");
  throws(() => defineSurface({ key: "", trust: "internal" }), "defineSurface: an empty key is malformed");
  throws(() => defineSurface({ key: "discord/", trust: "internal" }), "defineSurface: a trailing-slash empty segment is malformed");
}

{
  throws(() => defineSurface({ key: "discord/G1", trust: "external" as unknown as Surface["trust"] }), "defineSurface: trust 'external' is unknown (it is the default, never listed)");
  throws(() => defineSurface({ key: "discord/G1", trust: "wat" as unknown as Surface["trust"] }), "defineSurface: an arbitrary unknown trust is rejected");
}

{
  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "discord/G1", trust: "internal" }),
    defineSurface({ key: "discord/G1", trust: "internal" }),
  ]);
  ok(isVouchedInternal("discord/G1", "discord/G1/C1"), "registerSurfaces: a same-trust duplicate is idempotent (still vouched)");

  throws(
    () =>
      registerSurfaces([
        { key: "discord/G1", trust: "internal" },
        { key: "discord/G1", trust: "other" as unknown as Surface["trust"] },
      ]),
    "registerSurfaces: a duplicate key with CONFLICTING trust throws (config must not contradict itself)",
  );
  throws(() => registerSurfaces([{ key: "nope", trust: "internal" }]), "registerSurfaces: re-validates entries (a malformed key throws)");
  _resetSurfacesForTest();
}

{
  _resetSurfacesForTest();
  ok(!isVouchedInternal("discord/G1", "discord/G1/C1"), "empty register: nothing is vouched-internal (fail-closed default)");
  ok(!isVouchedSurface("discord/G1/C1"), "empty register: nothing is vouched at surface grain (fail-closed default)");
  eq(vouchedSurfaces(), [], "empty register: vouchedSurfaces() is empty");
}

{
  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: "discord/G1", trust: "internal" })]);
  ok(isVouchedInternal("discord/G1", "discord/G1/C1"), "workspace-grain: a workspace vouch covers a surface under it (isVouchedInternal)");
  ok(isVouchedInternal("discord/G1", "discord/G1/C_OTHER"), "workspace-grain: it covers EVERY surface under the workspace");
  ok(!isVouchedSurface("discord/G1/C1"), "workspace-grain: a workspace vouch does NOT satisfy the exact-grain isVouchedSurface");
  ok(isVouchedSurface("discord/G1"), "workspace-grain: the workspace key itself IS exact-vouched");

  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: "discord/G1/C1", trust: "internal" })]);
  ok(isVouchedSurface("discord/G1/C1"), "surface-grain: an exact surface vouch satisfies isVouchedSurface");
  ok(isVouchedInternal("discord/G1", "discord/G1/C1"), "surface-grain: it also satisfies the any-grain isVouchedInternal");
  ok(!isVouchedInternal("discord/G1", "discord/G1/C_SIBLING"), "surface-grain: a sibling surface stays external (narrowed to the one)");
  ok(!isVouchedSurface("discord/G1"), "surface-grain: the parent workspace is NOT swept in by a surface vouch");
}

{
  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "discord/G1", trust: "internal" }),
    defineSurface({ key: "github/example-owner/e2e-scratch", trust: "internal" }),
  ]);
  eq(
    [...vouchedSurfaces()].sort(),
    ["discord/G1", "github/example-owner/e2e-scratch"].sort(),
    "vouchedSurfaces(): returns exactly the registered keys",
  );
  registerSurfaces([defineSurface({ key: "teams/T1/C1", trust: "internal" })]);
  eq(vouchedSurfaces(), ["teams/T1/C1"], "vouchedSurfaces(): a later registerSurfaces REPLACES the previous register");
  _resetSurfacesForTest();
}

console.log(`\n✓ surface-trust: ${n} assertions passed`);
