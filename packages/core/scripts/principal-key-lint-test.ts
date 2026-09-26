import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findPrincipalKeyDefects, findComposerDeclarations, PRINCIPAL_KEY_MODULE } from "../agent/identity/principal-key-rules.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const F = "packages/core/agent/tools/example.ts";
const defects = (src: string, file = F) => findPrincipalKeyDefects(file, src);

{
  const two = defects("const key = `${binding.platform}/${principalId}`;");
  ok(two.length === 1 && two[0]!.rule === "composition", "🔴 the TWO-segment hand-roll `${platform}/${principalId}` is a defect — the shape the lint was written for");
  ok(two[0]!.message.includes("principalKey()"), "…and the message names the one function to call instead");

  const three = defects("const key = `${platform}/${tenant}/${nativeId}`;");
  ok(three.length === 1, "🔴 the THREE-segment hand-roll is caught too — the rule survives the phase-1 grammar change instead of being written against today's shape");

  ok(defects("const key = `${b.platform}/${b.workspace}`;").length === 0, "a TENANT key is not a principal key — a place, not a person");
  ok(defects("const key = `${b.platform}/${b.workspace}/${b.surface}`;").length === 0, "…and neither is a SURFACE key (the 225-literal false-positive class the anchor exists to avoid)");
  ok(defects("const key = `${platform}/${channelId}`;").length === 0, "…nor `channelId`, which ends in `Id` but names a room");
  ok(defects("const key = `${platform}/${workspaceId}`;").length === 0, "…nor `workspaceId`, for the same reason — the bare-`id` test ANCHORS, it does not substring-match");

  ok(defects("const key = `${platform}/${id}`;").length === 1, "a BARE `id` as the whole final expression IS a person (three of the real finds spelled it exactly that way)");
  ok(defects("const key = `${parsed.platform}/${parsed.id}`;").length === 1, "…including through a property access");

  ok(defects("// a call site that hand-rolls `${platform}/${principalId}` is wrong").length === 0, "a COMMENT spelling the grammar is documentation, not a second implementation");
  ok(defects("const key = `${platform}/${principalId}`;", "packages/core/agent/identity/principal-key.ts").length === 0, "the grammar's OWN module is exempt — it is the composer");
}

{
  for (const decl of ["function stripPrincipalKey(k: string) {", "const unqualifiedPrincipal = (k: string) =>", "const bareKey = (k: string) =>", "function legacyPrincipalOf(k: string) {"]) {
    const d = defects(decl);
    ok(d.length === 1 && d[0]!.rule === "unqualifier", `🔴 \`${decl.slice(0, 34)}…\` is refused by NAME — before anybody writes one with a compatibility justification`);
  }
  ok(defects("function stripMarkdown(s: string) {").length === 0, "…while an unrelated `strip*` is untouched (the rule pairs a stripping verb WITH principal vocabulary)");
  ok(defects("const barePrincipalId = stripped;").length === 1, "a CONST pairing a stripping verb with principal vocabulary is caught too — the shape is the value, not the function that made it");
  ok(defects("const principalId = row.principalId;").length === 0, "…while the ordinary spelling of the id half is untouched");
}

{
  const decls = findComposerDeclarations(PRINCIPAL_KEY_MODULE, readFileSync(new URL(`../../../${PRINCIPAL_KEY_MODULE}`, import.meta.url), "utf8"));
  ok(decls.length === 1, `the real principal-key module declares exactly one composer (found ${decls.length}) — the fixture assertions above are about a rule that binds the actual tree`);
  ok(findComposerDeclarations(F, "export function principalKey(platform: string, id: string) {").length === 1, "a SECOND composer anywhere else is visible to the driver, which is the tree-level problem a per-line rule cannot express");
  ok(findComposerDeclarations(F, "// export function principalKey(a, b) {").length === 0, "…and a commented-out one is not a composer");
}

console.log(`principal-key-lint: ${n} assertions passed`);

// proves: AP-MOD-core-identity-principal-key-rules
