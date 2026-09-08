import assert from "node:assert/strict";
import {
  defineSurface,
  registerSurfaces,
  registeredSurfaces,
  _resetSurfacesForTest,
  declaredSurfaceTrust,
  declaredTrustForKeys,
  declaredWorkspaceTrust,
  isVouchedInternal,
  isVouchedSurface,
  FLOOR_UNREACHABLE_RUNGS,
  registerSubtreePlatform,
  applySubtreeSurfaceClaims,
  subtreeSurfaceKeys,
  _resetSubtreePlatformsForTest,
  type Surface,
} from "../agent/identity/trust.js";
import { bindFrom, registerIdentityMapper, type BindableContext, type IdentityMapper } from "../agent/identity/binding.js";
import { _resetDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

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
    defineSurface({ key: "teams/deadbeef-74bc/19-abc-thread.tacv2", trust: "internal" }).key.length > 0,
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
  eq(registeredSurfaces(), [], "empty register: registeredSurfaces() is empty");
}

{
  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: "discord/G1", trust: "internal" })]);
  ok(isVouchedInternal("discord/G1", "discord/G1/C1"), "workspace-grain: a workspace vouch covers a surface under it (isVouchedInternal)");
  ok(isVouchedInternal("discord/G1", "discord/G1/C_OTHER"), "workspace-grain: it covers EVERY surface under the workspace");
  ok(isVouchedSurface("discord/G1/C1"), "🔴 workspace-grain: a workspace vouch ALSO satisfies isVouchedSurface — the two readers walk the same rungs (OPE-1521)");
  ok(isVouchedSurface("discord/G1"), "workspace-grain: the workspace key itself is vouched");

  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: "discord/G1/C1", trust: "internal" })]);
  ok(isVouchedSurface("discord/G1/C1"), "surface-grain: an exact surface vouch satisfies isVouchedSurface");
  ok(isVouchedInternal("discord/G1", "discord/G1/C1"), "surface-grain: it also satisfies the any-grain isVouchedInternal");
  ok(!isVouchedInternal("discord/G1", "discord/G1/C_SIBLING"), "surface-grain: a sibling surface stays external (narrowed to the one)");
  ok(!isVouchedSurface("discord/G1/C_SIBLING"), "surface-grain: the sibling stays external through the floor reader too");
  ok(!isVouchedSurface("discord/G1"), "surface-grain: the parent workspace is NOT swept in by a surface vouch (the walk goes UP, never down)");
}

{
  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: "teams/T_ACME", trust: "internal" })]);
  ok(isVouchedSurface("teams/T_ACME/19_channel"), "🔴 rung walk: a TENANT-only declaration vouches a channel under it — the operator declares the tenant once");
  ok(isVouchedSurface("teams/T_ACME/19_other"), "rung walk: it reaches every channel under that tenant, not one");
  ok(!isVouchedSurface("teams/T_OTHER/19_channel"), "🔴 rung walk NEGATIVE CONTROL: an UNDECLARED sibling tenant is not vouched — the walk goes up its OWN rungs, never across");
  ok(!isVouchedSurface("slack/T_ACME/19_channel"), "rung walk: the same tenant segment under a DIFFERENT platform is not vouched (the platform rung is matched too)");

  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "teams/T_ACME", trust: "internal" }),
    defineSurface({ key: "teams/T_ACME/19_connect", trust: "public" }),
  ]);
  ok(isVouchedSurface("teams/T_ACME/19_channel"), "rung walk: an unlisted room under the internal tenant is still vouched");
  ok(!isVouchedSurface("teams/T_ACME/19_connect"), "🔴 rung walk: an EXACT `public` declaration beats the internal tenant it sits under — the carve-out reaches the floor");

  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "teams/T_ACME", trust: "public" }),
    defineSurface({ key: "teams/T_ACME/19_channel", trust: "internal" }),
  ]);
  ok(isVouchedSurface("teams/T_ACME/19_channel"), "🔴 rung walk: an EXACT `internal` declaration still wins under a `public` tenant");
  ok(!isVouchedSurface("teams/T_ACME/19_other"), "rung walk: its siblings stay with the `public` tenant");

  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "github/acme", trust: "internal" }),
    defineSurface({ key: "github/acme/oss-*", trust: "public" }),
  ]);
  ok(isVouchedSurface("github/acme/payments-api"), "rung walk: a repo under the internal org is vouched");
  ok(!isVouchedSurface("github/acme/oss-sdk"), "rung walk: a `public` GLOB demotes the repos it names, even under an internal org");
  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: "github/acme/payments-*", trust: "internal" })]);
  ok(isVouchedSurface("github/acme/payments-api"), "rung walk: an `internal` GLOB vouches the repos it names");
  ok(!isVouchedSurface("github/acme/billing-api"), "rung walk: a repo the glob does not name stays external (the org itself is undeclared)");

  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "teams/T_ACME", trust: "internal" }),
    defineSurface({ key: "teams/T_ACME/team:X", trust: "public" }),
  ]);
  eq(
    declaredSurfaceTrust({ tenantKey: "teams/T_ACME", surfaceKeys: ["teams/T_ACME/19_x"], groupKey: "teams/T_ACME/team:X" }),
    "public",
    "group rung: a caller that HOLDS the group key resolves the `public` group declaration — the demotion exists",
  );
  ok(
    !isVouchedSurface("teams/T_ACME/19_x", { groupKey: "teams/T_ACME/team:X" }),
    "🔴 group rung: isVouchedSurface GIVEN the group key sees the `public` carve-out and refuses, matching every other plane (OPE-1538)",
  );
  ok(
    isVouchedSurface("teams/T_ACME/19_x"),
    "group rung is OPT-IN: the same key with NO group key passed still admits on the tenant line — no non-Teams caller changed",
  );
  ok(
    isVouchedSurface("teams/T_ACME/19_y", { groupKey: "teams/T_ACME/team:OTHER" }),
    "group rung: a room in a DIFFERENT team keeps the internal tenant line — the carve-out demotes one team, not the tenant",
  );

  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "teams/T_WIDE", trust: "public" }),
    defineSurface({ key: "teams/T_WIDE/team:IN", trust: "internal" }),
  ]);
  ok(
    !isVouchedSurface("teams/T_WIDE/19_z"),
    "precondition: with NO group key the `public` tenant line refuses — the answer before the rung is supplied",
  );
  ok(
    isVouchedSurface("teams/T_WIDE/19_z", { groupKey: "teams/T_WIDE/team:IN" }),
    "🔴 group rung PROMOTES too: an `internal` team under a `public` tenant ADMITS — supplying a rung changes the answer in BOTH directions, and the floor's doc must not claim otherwise",
  );
  ok(
    !isVouchedSurface("teams/T_WIDE/19_z", { groupKey: "teams/T_WIDE/team:NOTDECLARED" }),
    "🔴 …but an UNDECLARED team gets nothing from the rung — the fail-closed default is untouched, which is the property that actually matters",
  );

  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "teams/T_CONT", trust: "internal" }),
    defineSurface({ key: "teams/T_CONT/19_chan", trust: "public" }),
  ]);
  ok(
    isVouchedSurface("teams/T_CONT/19_chan-messageid-1"),
    "precondition: asked with the reply-chain key ALONE, the `public` CHANNEL declaration is invisible and the tenant line admits",
  );
  ok(
    !isVouchedSurface("teams/T_CONT/19_chan-messageid-1", { containerKey: "teams/T_CONT/19_chan" }),
    "🔴 container grain: carrying the CHANNEL key makes the `public` carve-out visible and the chain is REFUSED — the fail-open miss OPE-1538 closes one rung below the group",
  );
  ok(
    isVouchedSurface("teams/T_CONT/19_other-messageid-1", { containerKey: "teams/T_CONT/19_other" }),
    "container grain: a chain in an UNDECLARED channel still admits on the tenant line — the container key demotes only where a declaration says so",
  );
  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "teams/T_CONT2", trust: "internal" }),
    defineSurface({ key: "teams/T_CONT2/19_chan", trust: "public" }),
    defineSurface({ key: "teams/T_CONT2/19_chan-messageid-9", trust: "internal" }),
  ]);
  ok(
    isVouchedSurface("teams/T_CONT2/19_chan-messageid-9", { containerKey: "teams/T_CONT2/19_chan" }),
    "🔴 container grain: an exact REPLY-CHAIN declaration beats the channel's — same-tier ties break on the caller's key order, and raw comes first, as in bindFrom",
  );
  ok(
    !isVouchedSurface("teams/T_CONT2/19_chan-messageid-8", { containerKey: "teams/T_CONT2/19_chan" }),
    "…while a sibling chain with no entry of its own still takes the channel's `public` — so (c) measured the chain entry, not the container being ignored",
  );
  ok(
    isVouchedSurface("teams/T_CONT2/19_solo", { containerKey: "teams/T_CONT2/19_solo" }) === isVouchedSurface("teams/T_CONT2/19_solo"),
    "container grain: passing the SAME key as both grains answers identically to passing it once",
  );

  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: "teams/T_ACME", trust: "internal" })]);
  ok(!isVouchedSurface("teams"), "rung walk: a one-segment key has no tenant rung — fail closed (a platform-only derivation bug would admit here)");
  ok(!isVouchedSurface(""), "rung walk: an empty key returns false rather than throwing (a total function, not a vouch claim)");
  _resetSurfacesForTest();
}

{
  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: "slack/E0GRID", trust: "internal" })]);
  const sibling = (extra: Partial<{ enterpriseKey: string }> = {}) =>
    declaredSurfaceTrust({ tenantKey: "slack/T0SIB", surfaceKeys: ["slack/T0SIB/C0ROOM"], ...extra });
  eq(
    sibling({ enterpriseKey: "slack/E0GRID" }),
    "internal",
    "🔴 enterprise rung: ONE `slack/E0GRID` declaration vouches a room in an UNDECLARED sibling workspace under it",
  );
  eq(
    sibling(),
    undefined,
    "🔴 enterprise rung NEGATIVE CONTROL: the SAME register and the SAME room, asked with NO enterprise key, declares nothing — the rung is what carries the vouch, not the register",
  );
  eq(
    declaredSurfaceTrust({ tenantKey: "slack/T0SIB", surfaceKeys: ["slack/T0SIB/C0ROOM"], enterpriseKey: "slack/E0OTHER" }),
    undefined,
    "enterprise rung: an UNDECLARED enterprise vouches nothing — the walk goes up its own rungs, never across to a declared sibling Grid",
  );
  eq(
    declaredWorkspaceTrust("slack/T0SIB", "slack/E0GRID"),
    "internal",
    "enterprise rung: declaredWorkspaceTrust walks it too — the workspace-grain question a per-author membership probe asks",
  );
  eq(
    declaredWorkspaceTrust("slack/T0SIB"),
    undefined,
    "enterprise rung: declaredWorkspaceTrust WITHOUT the rung is unchanged — an existing caller keeps asking exactly what it asked",
  );

  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "slack/E0GRID", trust: "internal" }),
    defineSurface({ key: "slack/T0SIB", trust: "public" }),
  ]);
  eq(
    declaredSurfaceTrust({ tenantKey: "slack/T0SIB", surfaceKeys: ["slack/T0SIB/C0ROOM"], enterpriseKey: "slack/E0GRID" }),
    "public",
    "🔴 enterprise rung ORDER: a `public` WORKSPACE carve-out beats the `internal` enterprise above it — the narrower line wins",
  );
  eq(
    declaredSurfaceTrust({ tenantKey: "slack/T0HQ", surfaceKeys: ["slack/T0HQ/C0ROOM"], enterpriseKey: "slack/E0GRID" }),
    "internal",
    "enterprise rung ORDER: a workspace the carve-out does not name still rides the enterprise declaration",
  );
  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "slack/E0GRID", trust: "public" }),
    defineSurface({ key: "slack/T0SIB", trust: "internal" }),
  ]);
  eq(
    declaredSurfaceTrust({ tenantKey: "slack/T0SIB", surfaceKeys: ["slack/T0SIB/C0ROOM"], enterpriseKey: "slack/E0GRID" }),
    "internal",
    "🔴 enterprise rung ORDER, mirrored: a `public` ENTERPRISE does not demote the workspace the operator declared internal beneath it",
  );
  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "slack/E0GRID", trust: "internal" }),
    defineSurface({ key: "slack/T0SIB/C0CONNECT", trust: "public" }),
  ]);
  eq(
    declaredSurfaceTrust({ tenantKey: "slack/T0SIB", surfaceKeys: ["slack/T0SIB/C0CONNECT"], enterpriseKey: "slack/E0GRID" }),
    "public",
    "enterprise rung: an EXACT room carve-out beats the enterprise two rungs above it",
  );
  _resetSurfacesForTest();
}

{
  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "discord/G1", trust: "internal" }),
    defineSurface({ key: "github/example-owner/e2e-scratch", trust: "internal" }),
  ]);
  eq(
    registeredSurfaces().map((e) => e.key).sort(),
    ["discord/G1", "github/example-owner/e2e-scratch"].sort(),
    "registeredSurfaces(): returns exactly the registered entries",
  );
  registerSurfaces([defineSurface({ key: "teams/T1/C1", trust: "internal" })]);
  eq(registeredSurfaces().map((e) => e.key), ["teams/T1/C1"], "registeredSurfaces(): a later registerSurfaces REPLACES the previous register");
  _resetSurfacesForTest();
}

{
  ok(defineSurface({ key: "slack/T0/C_LOUNGE", trust: "public" }).trust === "public", "defineSurface: `public` is a declarable value");
  throws(
    () => defineSurface({ key: "slack/T0", trust: "external" as unknown as Surface["trust"] }),
    "defineSurface: `external` is STILL refused — it is the fail-closed default of an UNLISTED surface, and `public` is how an operator DECLARES a room external",
  );
}

{
  ok(defineSurface({ key: "github/acme/payments-*", trust: "internal" }).key === "github/acme/payments-*", "defineSurface: a same-level trailing glob is well-formed");
  ok(defineSurface({ key: "github/acme/*", trust: "public" }).key.length > 0, "defineSurface: a bare `*` surface segment is a legal same-level glob");
  throws(() => defineSurface({ key: "github/acme/pay**", trust: "internal" }), "defineSurface: `**` is refused (overlap must stay decidable)");
  throws(() => defineSurface({ key: "github/acme/*-pay", trust: "internal" }), "defineSurface: a mid-string `*` is refused");
  throws(() => defineSurface({ key: "github/acme/pay*x", trust: "internal" }), "defineSurface: a `*` that is not the LAST character is refused");
  throws(() => defineSurface({ key: "git*/acme", trust: "internal" }), "defineSurface: a `*` in the PLATFORM segment is refused (a glob narrows within a tenant, never across)");
  throws(() => defineSurface({ key: "github/ac*/x", trust: "internal" }), "defineSurface: a `*` in the TENANT segment is refused");
}

{
  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "github/acme", trust: "internal" }),
    defineSurface({ key: "github/acme/oss-*", trust: "public" }),
    defineSurface({ key: "github/acme/oss-internal-mirror", trust: "internal" }),
  ]);
  eq(declaredTrustForKeys("github/acme", "github/acme/payments-api"), "internal", "tier 3: an unmatched repo inherits the TENANT declaration");
  eq(declaredTrustForKeys("github/acme", "github/acme/oss-sdk"), "public", "tier 2: a GLOB beats the tenant declaration");
  eq(
    declaredTrustForKeys("github/acme", "github/acme/oss-internal-mirror"),
    "internal",
    "tier 1: an EXACT entry beats the glob — an explicitly-listed surface can never be ANNEXED by a broader pattern",
  );
  eq(declaredTrustForKeys("github/other", "github/other/x"), undefined, "a different tenant is UNDECLARED (silence, not `public`)");

  ok(isVouchedInternal("github/acme", "github/acme/payments-api"), "carve-out: a repo under the internal tenant is vouched internal");
  ok(!isVouchedInternal("github/acme", "github/acme/oss-sdk"), "🔴 carve-out: a repo the operator declared PUBLIC is NOT vouched internal, even under an internal tenant");
  ok(isVouchedInternal("github/acme", "github/acme/oss-internal-mirror"), "carve-out: the exact re-declaration wins the repo back");
}

{
  _resetSurfacesForTest();
  registerSurfaces([
    defineSurface({ key: "slack/T0", trust: "internal" }),
    defineSurface({ key: "slack/T0/C_LOUNGE", trust: "public" }),
    defineSurface({ key: "github/acme/oss-*", trust: "public" }),
  ]);
  eq(
    registeredSurfaces().filter((e) => e.trust === "internal").map((e) => e.key),
    ["slack/T0"],
    "🔴 the diagnostic read hands back every entry WITH its trust — a caller cannot lose the internal/public distinction the way a flat key list forced it to",
  );
  ok(!isVouchedSurface("slack/T0/C_LOUNGE"), "isVouchedSurface: an EXACT `public` entry is not vouched — it beats the internal tenant above it");
  ok(!isVouchedSurface("github/acme/oss-sdk"), "isVouchedSurface: a `public` GLOB is not vouched");
  eq(registeredSurfaces().length, 3, "registeredSurfaces(): every entry, whatever its trust (the preflight input)");
}

{
  _resetSurfacesForTest();
  throws(
    () =>
      registerSurfaces([
        defineSurface({ key: "github/acme/pay-*", trust: "public" }),
        defineSurface({ key: "github/acme/pay-roll-*", trust: "internal" }),
      ]),
    "registerSurfaces: two same-tier globs that could match ONE key with DIFFERENT trust throw (the winner would be declaration order)",
  );
  assert.doesNotThrow(
    () =>
      registerSurfaces([
        defineSurface({ key: "github/acme/pay-*", trust: "public" }),
        defineSurface({ key: "github/acme/pay-roll-*", trust: "public" }),
      ]),
    "registerSurfaces: the same overlapping pair AGREEING on trust is legal (there is nothing to resolve)",
  );
  n++;
  assert.doesNotThrow(
    () =>
      registerSurfaces([
        defineSurface({ key: "github/acme/pay-*", trust: "public" }),
        defineSurface({ key: "github/acme/pay-roll", trust: "internal" }),
      ]),
    "registerSurfaces: a DIFFERENT-tier overlap is legal — most-specific-wins settles it without a coin flip",
  );
  n++;
  assert.doesNotThrow(
    () =>
      registerSurfaces([
        defineSurface({ key: "github/acme/pay-*", trust: "public" }),
        defineSurface({ key: "github/other/pay-roll-*", trust: "internal" }),
      ]),
    "registerSurfaces: two disagreeing globs in DIFFERENT tenants cannot match one key — legal",
  );
  n++;
  _resetSurfacesForTest();
}

{
  _resetSurfacesForTest();
  const config = [
    "discord/1300000000000000100",
    "discord/300000000000000104",
    "teams/deadbeef-1111/19-0example-thread.tacv2",
    "linear/1a000000-5dfc",
    "linear/1a000000-5dfc/1a000000-f271",
    "notion/40000000-0001",
    "notion/40000000-0001/40000000-0101",
    "github/example-owner",
    "github/example-owner/e2e-scratch",
  ];
  registerSurfaces(config.map((key) => defineSurface({ key, trust: "internal" as const })));
  const legacy = new Set(config);
  const legacyIsVouched = (ws: string, sk: string) => legacy.has(ws) || legacy.has(sk);
  const probes: readonly (readonly [string, string])[] = [
    ["discord/1300000000000000100", "discord/1300000000000000100/C_ANY"],
    ["discord/300000000000000104", "discord/300000000000000104/C_OTHER"],
    ["discord/NOT_LISTED", "discord/NOT_LISTED/C1"],
    ["teams/deadbeef-1111", "teams/deadbeef-1111/19-0example-thread.tacv2"],
    ["teams/deadbeef-1111", "teams/deadbeef-1111/19-OTHER-thread.tacv2"],
    ["linear/1a000000-5dfc", "linear/1a000000-5dfc/1a000000-f271"],
    ["linear/1a000000-5dfc", "linear/1a000000-5dfc/OTHER-TEAM"],
    ["notion/40000000-0001", "notion/40000000-0001/40000000-0101"],
    ["notion/OTHER-WS", "notion/OTHER-WS/some-page"],
    ["github/example-owner", "github/example-owner/e2e-scratch"],
    ["github/example-owner", "github/example-owner/anything-else"],
    ["github/someone-else", "github/someone-else/repo"],
  ];
  let divergences = 0;
  for (const [ws, sk] of probes) if (legacyIsVouched(ws, sk) !== isVouchedInternal(ws, sk)) divergences++;
  eq(divergences, 0, "🔴 MIGRATION: over the shipped all-`internal` config, the OLD either-grain OR and the NEW most-specific-wins agree on EVERY probe");
  ok(probes.some(([w, s]) => isVouchedInternal(w, s)), "MIGRATION negative control: at least one probe resolves vouched");
  ok(probes.some(([w, s]) => !isVouchedInternal(w, s)), "MIGRATION negative control: at least one probe resolves UNvouched");
  registerSurfaces([
    defineSurface({ key: "github/example-owner", trust: "internal" }),
    defineSurface({ key: "github/example-owner/e2e-scratch", trust: "public" }),
  ]);
  ok(
    legacyIsVouched("github/example-owner", "github/example-owner/e2e-scratch") &&
      !isVouchedInternal("github/example-owner", "github/example-owner/e2e-scratch"),
    "MIGRATION: the ONE deliberate divergence is a public carve-out — the old OR would have ignored it and vouched the surface anyway",
  );
  _resetSurfacesForTest();
}

{
  _resetSurfacesForTest();
  eq(declaredWorkspaceTrust("notion/ws1"), undefined, "declaredWorkspaceTrust: undeclared ⇒ undefined, NEVER `public` (silence is not a claim)");
  registerSurfaces([defineSurface({ key: "notion/ws1", trust: "internal" })]);
  eq(declaredWorkspaceTrust("notion/ws1"), "internal", "declaredWorkspaceTrust: a workspace declaration is read at the workspace grain");
  registerSurfaces([defineSurface({ key: "notion/ws1", trust: "public" })]);
  eq(
    declaredWorkspaceTrust("notion/ws1"),
    "public",
    "🔴 declaredWorkspaceTrust: a PUBLIC workspace now reaches the source-tier table's `public` row, which no config could previously produce",
  );
  registerSurfaces([defineSurface({ key: "notion/ws1/page-a", trust: "public" })]);
  eq(
    declaredWorkspaceTrust("notion/ws1"),
    undefined,
    "declaredWorkspaceTrust: a PAGE-grain declaration says nothing about the WORKSPACE — still undefined",
  );
  _resetSurfacesForTest();
}

{
  _resetSurfacesForTest();
  const TENANT = "teams/deadbeef";
  const CHANNEL = "teams/deadbeef/19-abc-thread.tacv2";
  const GROUP = "teams/deadbeef/team:eng-team-guid";
  const q = (extra: { groupKey?: string } = {}) => declaredSurfaceTrust({ tenantKey: TENANT, surfaceKeys: [CHANNEL], ...extra });

  registerSurfaces([defineSurface({ key: GROUP, trust: "internal" })]);
  eq(q({ groupKey: GROUP }), "internal", "team rung: a `team:<id>` declaration reaches a channel that carries that group key");
  eq(q(), undefined, "team rung: the SAME channel with NO group key is undeclared — the rung is opt-in per binding");
  eq(
    declaredSurfaceTrust({ tenantKey: TENANT, surfaceKeys: ["teams/deadbeef/19-other-thread.tacv2"], groupKey: "teams/deadbeef/team:other-team" }),
    undefined,
    "team rung: a channel in a DIFFERENT team is untouched by this team's declaration",
  );

  registerSurfaces([
    defineSurface({ key: TENANT, trust: "public" }),
    defineSurface({ key: GROUP, trust: "internal" }),
  ]);
  eq(q({ groupKey: GROUP }), "internal", "team rung: a GROUP declaration beats the TENANT declaration (a team is more specific)");
  registerSurfaces([
    defineSurface({ key: GROUP, trust: "internal" }),
    defineSurface({ key: CHANNEL, trust: "public" }),
  ]);
  eq(q({ groupKey: GROUP }), "public", "team rung: an EXACT channel declaration beats the GROUP declaration");

  registerSurfaces([defineSurface({ key: "teams/deadbeef/team:*", trust: "public" })]);
  eq(q({ groupKey: GROUP }), "public", "team rung: a group GLOB (`team:*`) matches any team under the tenant");
  eq(q(), undefined, "🔴 team rung: a group glob does NOT sweep in an ordinary channel key — no colon, no match");
  registerSurfaces([defineSurface({ key: "teams/deadbeef/*", trust: "public" })]);
  eq(q(), "public", "team rung: a surface glob matches the channel…");
  eq(
    declaredSurfaceTrust({ tenantKey: TENANT, surfaceKeys: ["teams/deadbeef/no-such-channel"], groupKey: GROUP }),
    "public",
    "…and a surface glob answers about surfaces only — the group key contributes nothing to it",
  );
  _resetSurfacesForTest();
}

{
  _resetSurfacesForTest();
  const TENANT = "teams/deadbeef-74bc";
  const CHANNEL = `${TENANT}/19-abc-thread.tacv2`;
  const THREAD = `${TENANT}/19-abc-thread.tacv2;messageid=1700000000000`;

  registerSurfaces([defineSurface({ key: TENANT, trust: "internal" })]);
  eq(declaredTrustForKeys(TENANT, CHANNEL), "internal", "tenant rung: a CHANNEL under the declared tenant resolves internal");
  eq(
    declaredSurfaceTrust({ tenantKey: TENANT, surfaceKeys: [THREAD, CHANNEL] }),
    "internal",
    "tenant rung: a THREAD under the declared tenant resolves internal (neither grain is declared itself)",
  );
  eq(
    declaredTrustForKeys("teams/other-tenant", "teams/other-tenant/19-abc-thread.tacv2"),
    undefined,
    "NEGATIVE CONTROL: a channel in a DIFFERENT tenant stays undeclared — the vouch is not global",
  );
  ok(
    isVouchedSurface(CHANNEL),
    "🔴 tenant rung: the tenant declaration DOES satisfy isVouchedSurface — the tenant vouch admits the room to the shared window (OPE-1521)",
  );

  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: CHANNEL, trust: "internal" })]);
  ok(isVouchedSurface(CHANNEL), "channel-only: the exact entry satisfies isVouchedSurface — the single-window floor opens");
  ok(!isVouchedSurface(`${TENANT}/19-other-thread.tacv2`), "channel-only NEGATIVE CONTROL: a sibling channel in the same tenant is NOT admitted (the channel line narrows)");
  eq(declaredTrustForKeys(TENANT, CHANNEL), "internal", "channel-only: …and the ordinary memory verdict is internal too");
  eq(
    declaredSurfaceTrust({ tenantKey: TENANT, surfaceKeys: [THREAD, CHANNEL] }),
    "internal",
    "channel-only: …and a thread inside that channel resolves on the channel key",
  );
  ok(!isVouchedSurface(THREAD), "channel-only: still exact — a thread is not itself exact-vouched");
  eq(
    declaredTrustForKeys(TENANT, `${TENANT}/19-UNNAMED-thread.tacv2`),
    undefined,
    "🔴 channel-only: a SIBLING room under the same tenant stays undeclared — this is what the tenant shortcut would promote",
  );
  _resetSurfacesForTest();
}

{
  _resetSurfacesForTest();
  _resetDeploymentIdentityForTest();
  for (const k of ["OE_TRUST", "OE_PLATFORM", "OE_MODE"]) delete process.env[k];

  const vendor: IdentityMapper = (ctx) => {
    const a = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, string> } } } }).session?.auth?.current?.attributes ?? {};
    return {
      workspace: a.ws,
      surface: a.sf,
      ...(a.domainSf ? { domainSurface: a.domainSf } : {}),
      mode: (a.mode as "channel" | "dm" | "mpim" | undefined) ?? "channel",
      ...(a.verdict ? { trust: a.verdict as "internal" | "external" } : {}),
      ...(a.group ? { trustGroup: a.group } : {}),
      ...(a.enterprise ? { trustEnterprise: a.enterprise } : {}),
    };
  };
  registerIdentityMapper("vendortest", vendor);
  const bind = (attrs: Record<string, string>): string =>
    bindFrom({
      channel: { kind: "vendortest" },
      session: { auth: { current: { attributes: attrs, principalId: "U1", principalType: "vendortest-user" } } },
    } as unknown as BindableContext).trust;

  registerSurfaces([defineSurface({ key: "vendortest/W1/C_LOUNGE", trust: "public" })]);
  eq(
    bind({ ws: "W1", sf: "C_LOUNGE", verdict: "internal" }),
    "external",
    "🔴 PRECEDENCE: a `public` declaration DEMOTES a room the vendor positively called internal — this is the Slack community-workspace case, which was inexpressible before",
  );

  registerSurfaces([defineSurface({ key: "vendortest/W1", trust: "internal" })]);
  eq(
    bind({ ws: "W1", sf: "C_CONNECT", verdict: "external" }),
    "external",
    "🔴 PRECEDENCE: an `internal` declaration can NOT re-promote a room the vendor positively called external (a Slack Connect channel stays external, whatever the operator claims)",
  );
  eq(
    bind({ ws: "W1", sf: "C_PLAIN" }),
    "internal",
    "PRECEDENCE: with NO vendor verdict, the `internal` declaration promotes the room off the fail-closed default",
  );
  eq(bind({ ws: "W_OTHER", sf: "C1" }), "external", "PRECEDENCE: an undeclared surface with no vendor verdict stays fail-closed external");

  registerSurfaces([defineSurface({ key: "vendortest/W1/C_PARENT", trust: "public" })]);
  eq(
    bind({ ws: "W1", sf: "T_THREAD", domainSf: "C_PARENT", verdict: "internal" }),
    "external",
    "PRECEDENCE: a declaration on the CONTAINER reaches the thread inside it (domainSurface is a candidate key)",
  );
  registerSurfaces([
    defineSurface({ key: "vendortest/W1/C_PARENT", trust: "public" }),
    defineSurface({ key: "vendortest/W1/T_THREAD", trust: "internal" }),
  ]);
  eq(
    bind({ ws: "W1", sf: "T_THREAD", domainSf: "C_PARENT" }),
    "internal",
    "PRECEDENCE: the room's OWN key beats its container's, at the same tier (surfaceKeys are in preference order)",
  );

  registerSurfaces([defineSurface({ key: "vendortest/W1/team:G9", trust: "public" })]);
  eq(
    bind({ ws: "W1", sf: "C_ANY", group: "team:G9", verdict: "internal" }),
    "external",
    "PRECEDENCE: a GROUP declaration demotes every surface that carries that group key",
  );
  eq(bind({ ws: "W1", sf: "C_ANY", verdict: "internal" }), "internal", "PRECEDENCE: the same surface WITHOUT the group key is untouched");
  eq(
    bind({ ws: "W1", sf: "C_ANY", group: "not a key segment", verdict: "internal" }),
    "internal",
    "PRECEDENCE: a MALFORMED trustGroup contributes no rung at all (refused, never repaired — a repaired segment could collide with a real key)",
  );

  registerSurfaces([defineSurface({ key: "vendortest/E_GRID", trust: "internal" })]);
  eq(
    bind({ ws: "W_SIB", sf: "C_ROOM", enterprise: "E_GRID" }),
    "internal",
    "PRECEDENCE: an ENTERPRISE declaration promotes a room in a workspace nobody declared — bindFrom passes the rung it reads off the envelope",
  );
  ok(
    !isVouchedSurface("vendortest/W_SIB/C_ROOM"),
    "🔴 THE DIVERGENCE, PINNED (OPE-1584): the single-window privacy floor answers FALSE for the room the binding just bound INTERNAL — it holds one surface key and cannot derive the Grid. FAIL-CLOSED, and the header may never claim key-for-key parity again",
  );
  eq(
    Object.keys(FLOOR_UNREACHABLE_RUNGS),
    ["enterpriseKey"],
    "🔴 …and the enterprise rung is the ONLY one this floor records as out of reach — the record forces the next author to CLASSIFY a new query field; the two arms above are what prove the classification, because the type cannot",
  );

  registerSurfaces([defineSurface({ key: "vendortest/W_SIB", trust: "internal" })]);
  eq(bind({ ws: "W_SIB", sf: "C_ROOM" }), "internal", "positive control: the TENANT rung binds the same room internal…");
  ok(
    isVouchedSurface("vendortest/W_SIB/C_ROOM"),
    "…and the floor AGREES there, because it derives the tenant from the key — only the enterprise rung diverges",
  );

  registerSurfaces([defineSurface({ key: "vendortest/W1/D_PARTNER", trust: "public" })]);
  eq(
    bind({ ws: "W1", sf: "D_PARTNER", mode: "dm", verdict: "internal" }),
    "external",
    "DM: a `public` declaration does not DEMOTE a DM — but the DM partner gate fails it closed anyway, because a public declaration is not a vouch",
  );
  registerSurfaces([defineSurface({ key: "vendortest/W1/D_PARTNER", trust: "internal" })]);
  eq(
    bind({ ws: "W1", sf: "D_PARTNER", mode: "dm", verdict: "internal" }),
    "internal",
    "DM: an `internal` declaration still vouches a DM partner exactly as before (the DM leg is unchanged)",
  );
  _resetSurfacesForTest();
}

{
  _resetSurfacesForTest();
  _resetSubtreePlatformsForTest();

  eq(
    defineSurface({ key: "notion/W1/P1", trust: "internal", subtree: true }).subtree,
    true,
    "defineSurface: an exact internal surface key CARRIES the subtree claim",
  );
  eq(defineSurface({ key: "notion/W1/P1", trust: "internal", subtree: false }).subtree, undefined, "defineSurface: `subtree: false` is dropped — it is the same declaration as leaving it out");
  eq(defineSurface({ key: "notion/W1/P1", trust: "internal" }).subtree, undefined, "defineSurface: an entry without the word carries no claim (the widening is opt-in on the line)");

  throws(
    () => defineSurface({ key: "notion/W1/P1", trust: "internal", subtree: "yes" as unknown as boolean }),
    "defineSurface: a non-boolean subtree throws (never coerced)",
  );
  throws(
    () => defineSurface({ key: "notion/W1", trust: "internal", subtree: true }),
    "defineSurface: subtree on a TENANT key throws — a tenant already covers every surface under it",
  );
  throws(
    () => defineSurface({ key: "notion/W1/P*", trust: "internal", subtree: true }),
    "defineSurface: subtree on a GLOB throws — a glob names a set nobody enumerated",
  );
  throws(
    () => defineSurface({ key: "teams/W1/team:T9", trust: "internal", subtree: true }),
    "defineSurface: subtree on a GROUP rung throws",
  );
  throws(
    () => defineSurface({ key: "notion/W1/P1", trust: "public", subtree: true }),
    "🔴 defineSurface: subtree with `public` throws — only the PROMOTION has a resolver, so a public subtree would be a demotion nothing reads",
  );
}

{
  _resetSurfacesForTest();
  _resetSubtreePlatformsForTest();
  registerSurfaces([defineSurface({ key: "notion/W1/P_ROOT", trust: "internal", subtree: true })]);
  eq(declaredTrustForKeys("notion/W1", "notion/W1/P_ROOT"), "internal", "the subtree entry still declares its OWN key internal");
  eq(
    declaredTrustForKeys("notion/W1", "notion/W1/P_CHILD"),
    undefined,
    "🔴 the PURE resolver is unchanged: it never widens a subtree entry — resolving a subtree costs an API call per level, and declaredSurfaceTrust is pure and synchronous",
  );
  eq(registeredSurfaces()[0]?.subtree, true, "the diagnostic read hands the claim back with the entry");
}

{
  _resetSurfacesForTest();
  _resetSubtreePlatformsForTest();
  throws(
    () =>
      registerSurfaces([
        defineSurface({ key: "notion/W1/P1", trust: "internal", subtree: true }),
        defineSurface({ key: "notion/W1/P1", trust: "internal" }),
      ]),
    "registerSurfaces: one line says subtree and another does not — a reviewed config must not contradict itself",
  );
  registerSurfaces([
    defineSurface({ key: "notion/W1/P1", trust: "internal", subtree: true }),
    defineSurface({ key: "notion/W1/P1", trust: "internal", subtree: true }),
  ]);
  eq(registeredSurfaces().length, 1, "registerSurfaces: two IDENTICAL subtree lines are idempotent");
}

{
  _resetSurfacesForTest();
  _resetSubtreePlatformsForTest();
  registerSurfaces([defineSurface({ key: "vendortest/W1/C1", trust: "internal", subtree: true })]);
  eq(registeredSurfaces()[0]?.subtree, true, "before the boot check the claim is merely RECORDED (the refusal is deferred, not skipped)");
  throws(
    () => applySubtreeSurfaceClaims(),
    "🔴 applySubtreeSurfaceClaims: a subtree claim on a platform NO bundle declared is a BOOT ERROR",
  );

  const handed: string[][] = [];
  registerSubtreePlatform("vendortest", (keys) => handed.push([...keys]));
  applySubtreeSurfaceClaims();
  eq(handed.at(-1), ["vendortest/W1/C1"], "a declared platform RECEIVES its keys through the handler");
  ok(handed.length >= 2, "the handler runs at registration AND at the boot check (both orders reach the same state)");
}

{
  _resetSurfacesForTest();
  _resetSubtreePlatformsForTest();
  let last: readonly string[] = ["never handed"];
  registerSubtreePlatform("vendortest", (keys) => {
    last = keys;
  });
  eq(last, [], "registering a platform against an EMPTY register hands it the empty list (fail-closed)");
  registerSurfaces([
    defineSurface({ key: "vendortest/W1/C_SUB", trust: "internal", subtree: true }),
    defineSurface({ key: "vendortest/W1/C_ONE", trust: "internal" }),
    defineSurface({ key: "vendortest/W2/C_SUB2", trust: "internal", subtree: true }),
    defineSurface({ key: "othervendor/W1/C_X", trust: "internal" }),
  ]);
  eq(
    last,
    ["vendortest/W1/C_SUB", "vendortest/W2/C_SUB2"],
    "🔴 registerSurfaces re-hands the platform its keys — an entry WITHOUT `subtree` is NOT one of them (the OPE-492 one-surface semantics)",
  );
  eq(subtreeSurfaceKeys("othervendor"), [], "a platform with no subtree entry gets nothing");
  eq(subtreeSurfaceKeys("vendortest").length, 2, "subtreeSurfaceKeys reads the same set the handler was handed");

  _resetSurfacesForTest();
  _resetSubtreePlatformsForTest();
  registerSubtreePlatform("vendortest", (keys) => {
    if (keys.length > 0) throw new Error("vendor refuses this key");
  });
  const badLine = [defineSurface({ key: "vendortest/W1/C_SUB", trust: "internal", subtree: true })];
  throws(() => registerSurfaces(badLine), "a platform's OWN key validation throws out of registerSurfaces");
  throws(() => applySubtreeSurfaceClaims(), "…and out of the boot check too");

  _resetSubtreePlatformsForTest();
  registerSubtreePlatform("vendortest", (keys) => {
    last = keys;
  });
  _resetSurfacesForTest();
  eq(last, [], "_resetSurfacesForTest re-hands the empty list (a dropped register does not leave stale roots behind)");
  _resetSubtreePlatformsForTest();
}

console.log(`\n✓ surface-trust: ${n} assertions passed`);
