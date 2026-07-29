import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseScopeKey } from "../agent/access/scope-key.js";
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
  if (p.kind === "domain" || p.kind === "malformed") return null;
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
  const src = readFileSync(new URL("../agent/access/scope-key.ts", import.meta.url), "utf-8");
  const code = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
    .join("\n");
  ok(!/^\s*import\s/m.test(code), "access/scope-key.ts imports nothing — it cannot pull the resolver, the bundle types, or the event plane in behind it");
  ok(!/ScopeStep|ScopeKind|event-model/.test(code), "access/scope-key.ts names nothing from the EVENT scope vocabulary (that fence is a security property, not tidiness)");
}

console.log(`\n✓ scopeKey grammar: ${n} assertions passed (one parser; the pre-OPE-240 copies reproduced and differenced)\n`);
