import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseScopeKey, platformOfScopeKey, userScopeKey } from "../agent/access/scope-key.js";
import { whereFromScope } from "../agent/approvals/actions.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

function legacyApprovalsWhere(org: string, scopeKey: string): Record<string, unknown> {
  const parts = scopeKey.split("/");
  if (parts.length === 1) {
    return { org, platform: "domain", workspace: parts[0] || "unknown" };
  }
  const [platform, workspace, surface] = parts;
  return { org, platform: platform || "unknown", workspace: workspace || "unknown", ...(surface ? { surface } : {}) };
}

function legacyControlWhere(org: string, scopeKey: string): Record<string, unknown> {
  const [platform, workspace, surface] = scopeKey.split("/");
  return { org, platform: platform || "unknown", workspace: workspace || "unknown", ...(surface ? { surface } : {}) };
}

function legacyLabelParse(scopeKey: string): { platform: string; workspace: string; surface?: string } | null {
  const parts = scopeKey.split("/");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p.length === 0)) return null;
  return { platform: parts[0], workspace: parts[1], surface: parts[2] };
}

function labelParseViaLeaf(scopeKey: string): { platform: string; workspace: string; surface?: string } | null {
  const p = parseScopeKey(scopeKey);
  if (p.kind === "domain" || p.kind === "principal" || p.kind === "malformed") return null;
  return { platform: p.platform, workspace: p.workspace, surface: p.kind === "surface" ? p.surface : undefined };
}

const KEYS = ["payments", "a", "", "slack/T1", "slack/T1/C1", "a/", "/b", "/", "//", "a//c", "a/b/", "a/b/c/d", "a/b/c/d/e"] as const;

eq(parseScopeKey("payments"), { kind: "domain", name: "payments" }, "a bare name is a DOMAIN — the shape hand-rolled split() destructuring loses");
eq(parseScopeKey("slack/T1"), { kind: "tenant", platform: "slack", workspace: "T1" }, "two segments is a tenant key");
eq(parseScopeKey("slack/T1/C1"), { kind: "surface", platform: "slack", workspace: "T1", surface: "C1" }, "three segments is a surface key");
eq(parseScopeKey("a//c"), { kind: "malformed", raw: "a//c", parts: ["a", "", "c"] }, "an empty interior segment is malformed, and carries its parts for salvage");
eq(parseScopeKey("a/b/c/d"), { kind: "malformed", raw: "a/b/c/d", parts: ["a", "b", "c", "d"] }, "more than three segments is malformed");
eq(parseScopeKey(""), { kind: "domain", name: "" }, "an empty key reads as a nameless domain — consumers fail open on it, nothing throws");

for (const k of KEYS) {
  ok(typeof parseScopeKey(k).kind === "string", `parseScopeKey(${JSON.stringify(k)}) returns a shape rather than throwing`);
}

for (const k of KEYS) {
  eq(whereFromScope("acme", k), legacyApprovalsWhere("acme", k), `whereFromScope(${JSON.stringify(k)}) is byte-identical to the pre-unification approvals copy`);
}

for (const k of KEYS) {
  eq(labelParseViaLeaf(k), legacyLabelParse(k), `the card's scope parse of ${JSON.stringify(k)} is unchanged (display-only, fail-open to null)`);
}

{
  const fixed = whereFromScope("acme", "payments");
  const broken = legacyControlWhere("acme", "payments");
  eq(fixed, { org: "acme", platform: "domain", workspace: "payments" }, "a domain-level scopeKey audits as platform:'domain' with the domain as the workspace");
  eq(broken, { org: "acme", platform: "payments", workspace: "unknown" }, "…where the deleted control-plane copy produced a platform that does not exist");
  ok(JSON.stringify(fixed) !== JSON.stringify(broken), "the two derivations genuinely disagreed — this test would be vacuous if they did not");
}

for (const k of KEYS) {
  const isDomainShape = parseScopeKey(k).kind === "domain";
  const agrees = JSON.stringify(whereFromScope("acme", k)) === JSON.stringify(legacyControlWhere("acme", k));
  ok(agrees === !isDomainShape, `the divergence at ${JSON.stringify(k)} is present iff the key is a bare domain name`);
}

{
  const stripComments = (s: string) =>
    s
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
  const src = readFileSync(new URL("../agent/access/scope-key.ts", import.meta.url), "utf-8");
  const code = stripComments(src);
  const imports = [...code.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
  ok(imports.length === 1 && imports[0] === "../identity/principal-key.js", `access/scope-key.ts imports EXACTLY the principal-key composer and nothing else (got: ${JSON.stringify(imports)}) — it cannot pull the resolver, the bundle types, or the event plane in behind it`);

  const leafSrc = readFileSync(new URL("../agent/identity/principal-key.ts", import.meta.url), "utf-8");
  ok(!/^\s*import\s/m.test(stripComments(leafSrc)), "…and the one module it admits is itself import-free, so the transitive closure is exactly those two files — the property the old `imports nothing` line was a proxy for");

  ok(!/ScopeStep|ScopeKind|event-model/.test(code + stripComments(leafSrc)), "neither file names anything from the EVENT scope vocabulary (that fence is a security property, not tidiness)");
}

{
  eq(parseScopeKey("user:discord/300000000000000104"), { kind: "principal", platform: "discord", id: "300000000000000104" }, "a `user:`-marked key is a PRINCIPAL — the marker is stripped, both halves recovered");
  eq(parseScopeKey("discord/300000000000000104"), { kind: "tenant", platform: "discord", workspace: "300000000000000104" }, "🔴 …and the SAME person unmarked is indistinguishable from a tenant key: that is the reason the marker exists");
  eq(parseScopeKey("user:slack/T1/U0EXOWNER"), { kind: "principal", platform: "slack", tenant: "T1", id: "U0EXOWNER" }, "a marked TENANT-SCOPED principal key recovers all three parts");
  eq(parseScopeKey("slack/T1/U0EXOWNER"), { kind: "surface", platform: "slack", workspace: "T1", surface: "U0EXOWNER" }, "🔴 …and the same person unmarked reads as a SURFACE key — the marker, not the segment count, is what decides");
  eq(parseScopeKey("user:slack"), { kind: "malformed", raw: "user:slack", parts: ["slack"] }, "a marked key with no id is malformed, not a domain named 'slack'");
  eq(parseScopeKey("user:/U1"), { kind: "malformed", raw: "user:/U1", parts: ["", "U1"] }, "a marked key with no platform is malformed");
  eq(parseScopeKey("user:discord/G1/U1"), { kind: "malformed", raw: "user:discord/G1/U1", parts: ["discord", "G1", "U1"] }, "a marked key with a third segment on a VENDOR-GLOBAL platform is malformed, never a surface");
  eq(parseScopeKey("user:slack/U1"), { kind: "malformed", raw: "user:slack/U1", parts: ["slack", "U1"] }, "🔴 …and a PRE-RUNG two-segment slack key is malformed too — it addresses nobody the composer can mint, so reading it as a person would be worse than reading it as broken");
  ok(userScopeKey("slack", "T1", "U1") === "user:slack/T1/U1", "userScopeKey is the ONE minter of the marked form");
  ok(parseScopeKey(userScopeKey("discord", undefined, "300000000000000104")).kind === "principal", "mint ⇄ parse round-trips on a snowflake id (the digit-string case the qualification exists for)");

  eq(whereFromScope("acme", "user:slack/T1/U1"), { org: "acme", platform: "user", workspace: "slack/T1/U1" }, "a principal scope audits as platform:'user' with the qualified principal key as the workspace");
  ok(platformOfScopeKey("user:slack/T1/U1") === "slack", "platformOfScopeKey answers with the person's real platform — the marker is what makes that a fact rather than a guess");
  ok(platformOfScopeKey("payments") === undefined, "…while a bare domain name still answers undefined (unchanged)");

  for (const k of ["user:slack/T1/U1", "user:slack/U1", "user:", "user:/", "user:a/b/c"]) {
    ok(typeof parseScopeKey(k).kind === "string", `parseScopeKey(${JSON.stringify(k)}) returns a shape rather than throwing`);
  }
}

console.log(`\n✓ scopeKey grammar: ${n} assertions passed (one parser; the pre-OPE-240 copies reproduced and differenced)\n`);

// proves: AP-MOD-core-access-scope-key
