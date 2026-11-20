import assert from "node:assert/strict";

import type { SkillPackageDefinition } from "eve/skills";
import { SKILL_CONTENT } from "../agent/plugins/skill-content.js";
import { extractPlugin } from "../packages/core/agent/plugins/extract.js";
import type { ParsedPlugin } from "../packages/core/agent/plugins/types.js";
import { mergeRepoSkills, type RepoSkillsEntry } from "../packages/core/agent/scm/repo-skills.js";
import { skillPackageFromRow } from "../packages/core/agent/skills/domain-skills.js";
import { loadNormalizeSkillPackage, type EveNormalizedSkillPackage } from "./eve-deep-reads/skill-package.js";

// Every skill package this repository produces goes through eve's own skill normalizer, the function
// eve runs on each entry a `defineDynamic` skill resolver returns. A package that does not match
// eve's `SkillPackageDefinition` throws there, and the turn fails before the model runs. This test
// drives each producer's output through that exact function: a domain skill row, a repo skill, a
// repo delegation agent, a plugin skill with files, a plugin command, and the app's static skill
// content. It also checks that no producer adds a key eve does not read, so a package that carries
// a stray `markdown` beside `content` fails here too.

const normalize = await loadNormalizeSkillPackage(process.cwd());

/**
 * The keys of eve's `SkillPackageDefinition`, copied from `node_modules/eve/dist/src/shared/skill-definition.d.ts`.
 * A key outside this set is dead weight eve never reads. When an eve bump adds a key that a producer uses, add it here.
 */
const EVE_SKILL_PACKAGE_KEYS: ReadonlySet<string> = new Set(["deferred", "description", "license", "content", "metadata", "files"]);

let failed = 0;
let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Normalizes one package with eve's own function and checks every byte eve writes against the package. */
function assertEveTakes(name: string, pkg: SkillPackageDefinition): EveNormalizedSkillPackage {
  const stray = Object.keys(pkg).filter((key) => !EVE_SKILL_PACKAGE_KEYS.has(key));
  assert.deepEqual(stray, [], `${name}: the package carries keys eve does not read: ${stray.join(", ")}`);
  assert.equal(typeof pkg.content, "string", `${name}: the package has no string content`);
  assert.ok(pkg.content.trim().length > 0, `${name}: the package content is empty`);
  const out = normalize({ ...pkg, name });
  assert.equal(out.name, name);
  assert.equal(out.description, pkg.description, `${name}: eve keeps the description`);
  const skillMd = out.files.find((file) => file.relativePath === "SKILL.md");
  assert.ok(skillMd, `${name}: eve writes a SKILL.md`);
  assert.equal(skillMd.content.toString("utf8"), pkg.content, `${name}: the SKILL.md eve writes is the package content, byte for byte`);
  const declared = Object.entries(pkg.files ?? {});
  assert.equal(out.files.length, declared.length + 1, `${name}: eve writes SKILL.md plus every declared file`);
  for (const [path, body] of declared) {
    const file = out.files.find((f) => f.relativePath === path);
    assert.ok(file, `${name}: eve writes the declared file ${path}`);
    assert.ok(Buffer.from(body).equals(file.content), `${name}: the file ${path} keeps its bytes`);
  }
  return out;
}

// --- producer 1: a domain skill row ---

await test("🔴 a domain skill row becomes a package eve's normalizer takes", () => {
  const content = "---\ndescription: Close the month in the finance domain.\n---\n\nReconcile the ledger first.\n";
  const pkg = skillPackageFromRow({ org: "T0SYNTH", domain: "finance", name: "month-close", content, updatedAt: "2000-01-01T00:00:00.000Z" });
  assertEveTakes("month-close", pkg);
  assert.equal(pkg.description, "Close the month in the finance domain.");
});

await test("🔴 a domain skill row with no frontmatter gets a fallback description and still normalizes", () => {
  const pkg = skillPackageFromRow({ org: "T0SYNTH", domain: "ops", name: "page-oncall", content: "Page the on-call engineer.\n", updatedBy: "U0SYNTH", updatedAt: "2000-01-01T00:00:00.000Z" });
  assertEveTakes("page-oncall", pkg);
  assert.match(pkg.description, /Domain skill "page-oncall"/u);
});

// --- producer 2: a repo skill and a repo delegation agent ---

await test("🔴 a repo skill and a repo delegation agent become packages eve's normalizer takes", () => {
  const state: Record<string, RepoSkillsEntry> = {
    "payments-api": {
      repo: "example/payments-api",
      skills: { deploy: "---\ndescription: Ship the payments service.\n---\nRun the deploy steps.\n" },
      agents: { "code-reviewer": { name: "code-reviewer", description: "Reviews diffs for bugs.", body: "You are a careful reviewer." } },
    },
  };
  const merged = mergeRepoSkills(state, new Set(), () => {});
  assert.deepEqual(Object.keys(merged).sort(), ["payments-api--code-reviewer", "payments-api--deploy"]);
  for (const [name, pkg] of Object.entries(merged)) assertEveTakes(name, pkg);
});

// --- producer 3: a plugin skill with files, and a plugin command ---

await test("🔴 a plugin skill with files and a plugin command become packages eve's normalizer takes", () => {
  const plugin: ParsedPlugin = {
    manifest: { name: "Synth Tools", version: "1.0.0" },
    skills: [
      {
        slug: "runbook",
        packaged: true,
        skillMd: "---\nname: runbook\ndescription: Use when a runbook is needed.\n---\n\nFollow the runbook.\n",
        files: [
          { relPath: "references/checklist.md", content: "# Checklist\n" },
          { relPath: "scripts/check.sh", content: "#!/bin/sh\necho ok\n" },
        ],
      },
    ],
    commands: [{ slug: "triage", description: "Triage a bug.", body: "Investigate $ARGUMENTS." }],
    agents: [],
    mcpServers: [],
  };
  const { skillContent } = extractPlugin(plugin);
  const runbook = skillContent["synth-tools__runbook"];
  assert.ok(runbook, "the plugin skill is in the skill content map");
  assert.equal(assertEveTakes("synth-tools__runbook", runbook).files.length, 3, "SKILL.md plus the two declared files");
  const triage = skillContent["synth-tools__cmd-triage"];
  assert.ok(triage, "the plugin command is in the skill content map");
  assertEveTakes("synth-tools__cmd-triage", triage);
});

// --- producer 4: the app's static skill content ---

await test("🔴 every entry of the app's static skill content becomes a package eve's normalizer takes", () => {
  const entries = Object.entries(SKILL_CONTENT);
  assert.ok(entries.length > 0, "the app ships at least one static skill");
  for (const [name, pkg] of entries) assertEveTakes(name, pkg);
  const notion = SKILL_CONTENT["notion-rest"];
  assert.ok(notion?.files && Object.keys(notion.files).length > 0, "the notion-rest skill ships files beside its SKILL.md");
});

// --- the negative control: the checks reject a package in the old `markdown` shape ---

await test("🔴 NEGATIVE: eve's normalizer throws on a package that carries `markdown` and no `content`", () => {
  const legacy = { description: "Old shape.", markdown: "# Old\n" } as unknown as SkillPackageDefinition;
  assert.throws(() => normalize({ ...legacy, name: "legacy" }), /must be of type string/u);
  assert.throws(() => assertEveTakes("legacy", legacy), /keys eve does not read: markdown/u);
});

await test("🔴 NEGATIVE: a package that keeps a stray `markdown` beside `content` fails the key check", () => {
  const both = { description: "Both shapes.", content: "# New\n", markdown: "# Old\n" } as unknown as SkillPackageDefinition;
  assert.throws(() => assertEveTakes("both", both), /keys eve does not read: markdown/u);
});

await test("NEGATIVE CONTROL: a package in eve's shape passes every check", () => {
  assertEveTakes("well-formed", { description: "A well-formed skill.", content: "# Skill\nDo the thing.\n", files: { "notes.md": "notes\n" } });
});

console.log(`\nskill-package-shape: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
