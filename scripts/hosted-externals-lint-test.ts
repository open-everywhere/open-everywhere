import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isGeneratedDocsPage } from "./hosted-externals-source-scan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(root, "scripts", "hosted-externals-lint.ts");
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");

const SOURCE_RED = "computed dynamic import specifier(s) in runtime source";
const NO_OUTPUT = "no build output at";

const DOC_PROSE = "export const dev = `| top-level `await import(...)` | 271 |`;";
const REAL_COMPUTED_IMPORT = 'const mod = await import(["@scope", "pkg"].join("/"));';

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

const scratchRoots: string[] = [];

function scratchTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oe-hosted-externals-"));
  scratchRoots.push(dir);
  mkdirSync(join(dir, "packages", "providers"), { recursive: true });
  for (const [relative, body] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
  return dir;
}

function runLint(treeRoot: string): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, LINT], {
    cwd: treeRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: r.status ?? -1, stderr: `${r.stderr ?? ""}${r.stdout ?? ""}` };
}

try {
  {
    const tree = scratchTree({ "agent/registry.ts": `${REAL_COMPUTED_IMPORT}\n` });
    const { code, stderr } = runLint(tree);
    ok(code === 1, "(1) a computed dynamic import in agent/** exits 1");
    ok(stderr.includes(SOURCE_RED), "(1) the source pass reports the finding");
    ok(stderr.includes("agent/registry.ts:1:"), "(1) the finding names the file and the line");
  }

  {
    const tree = scratchTree({ "agent/docs/generated/dev.ts": `${DOC_PROSE}\n` });
    const { code, stderr } = runLint(tree);
    ok(!stderr.includes(SOURCE_RED), "(2) generated doc prose is not a source-pass finding");
    ok(stderr.includes(NO_OUTPUT), "(2) the run reaches the output pass");
    ok(code === 1, "(2) the CLI still exits 1 — an unbuilt tree is not a green gate");
  }

  {
    const tree = scratchTree({ "agent/docs/pages.ts": `${DOC_PROSE}\n` });
    const { code, stderr } = runLint(tree);
    ok(code === 1, "(3) the same text in a hand-written module exits 1");
    ok(stderr.includes("agent/docs/pages.ts:1:"), "(3) the finding names the hand-written file");
  }

  {
    const tree = scratchTree({
      "agent/lib/providers.generated.ts": `${REAL_COMPUTED_IMPORT}\n`,
      "agent/plugins/generated/index.ts": `${REAL_COMPUTED_IMPORT}\n`,
      "agent/generated/registry.ts": `${REAL_COMPUTED_IMPORT}\n`,
      "agent/docs/generated/index.ts": `${REAL_COMPUTED_IMPORT}\n`,
    });
    const { stderr } = runLint(tree);
    ok(stderr.includes("agent/lib/providers.generated.ts:1:"), "(4) a .generated.ts runtime module reds");
    ok(stderr.includes("agent/plugins/generated/index.ts:1:"), "(4) a non-docs generated/ module reds");
    ok(stderr.includes("agent/generated/registry.ts:1:"), "(4) generated/ outside docs/ reds");
    ok(stderr.includes("agent/docs/generated/index.ts:1:"), "(4) 🔴 the docs barrel keeps its coverage");
  }

  {
    const tree = scratchTree({
      "packages/providers/discord/agent/docs-generated.ts": `${DOC_PROSE}\n`,
      "packages/providers/discord/agent/register.ts": `${REAL_COMPUTED_IMPORT}\n`,
    });
    const { stderr } = runLint(tree);
    ok(!stderr.includes("docs-generated.ts:"), "(4b) a bundle's generated runbook is skipped");
    ok(
      stderr.includes("packages/providers/discord/agent/register.ts:1:"),
      "(4b) 🔴 a hand-written sibling in the same directory still reds",
    );
  }

  {
    const exempt = runLint(
      scratchTree({
        "agent/pglite.ts": `// hosted-inline-exempt: the WASM siblings must not be inlined\n${REAL_COMPUTED_IMPORT}\n`,
      }),
    );
    ok(!exempt.stderr.includes(SOURCE_RED), "(5) an exempted import is not a finding");
    ok(exempt.stderr.includes(NO_OUTPUT), "(5) the run reaches the output pass");
    const bare = scratchTree({ "agent/pglite.ts": `${REAL_COMPUTED_IMPORT}\n` });
    ok(runLint(bare).stderr.includes("agent/pglite.ts:1:"), "(5) control: without the comment it reds");
  }

  {
    const tree = scratchTree({ "packages/core/agent/boot.ts": `${REAL_COMPUTED_IMPORT}\n` });
    ok(runLint(tree).stderr.includes("packages/core/agent/boot.ts:1:"), "(6) packages/core/agent is walked");
    const provider = scratchTree({ "packages/providers/discord/agent/boot.ts": `${REAL_COMPUTED_IMPORT}\n` });
    ok(
      runLint(provider).stderr.includes("packages/providers/discord/agent/boot.ts:1:"),
      "(6) a provider's agent directory is walked",
    );
  }

  ok(isGeneratedDocsPage("agent/docs/generated/dev.ts"), "(7) generated/ inside docs/");
  ok(isGeneratedDocsPage("packages/core/agent/docs/generated/x.ts"), "(7) the same shape in any package");
  ok(
    isGeneratedDocsPage("packages/providers/notion/agent/docs-generated.ts"),
    "(7) a bundle's generated runbook",
  );
  ok(
    !isGeneratedDocsPage("packages/providers/notion/docs-generated.ts"),
    "(7) but only inside an agent/ directory",
  );
  ok(
    !isGeneratedDocsPage("packages/providers/notion/agent/docs-generated-test.ts"),
    "(7) the name must match exactly",
  );
  ok(!isGeneratedDocsPage("agent/docs/generated/index.ts"), "(7) 🔴 the barrel is code, not a page");
  ok(!isGeneratedDocsPage("agent/plugins/generated/index.ts"), "(7) generated/ outside docs/ is not");
  ok(!isGeneratedDocsPage("agent/access/grants.generated.ts"), "(7) the .generated.ts suffix is not");
  ok(!isGeneratedDocsPage("agent/docs/pages.ts"), "(7) a hand-written docs module is not");
  ok(!isGeneratedDocsPage("agent/docs/generated.ts"), "(7) nor a FILE called generated.ts");
  ok(!isGeneratedDocsPage("agent/generated/docs/x.ts"), "(7) nor docs/ inside generated/");

  {
    const builtins = [
      "path",
      "fs",
      "os",
      "stream",
      "zlib",
      "stream/promises",
      "fs/promises",
      "url",
      "module",
    ];
    const entry = builtins.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n");
    const valid = runLint(
      scratchTree({ ".vercel/output/functions/__server.func/index.mjs": `${entry}\n` }),
    );
    ok(valid.code === 0, "(8) unprefixed Node built-ins need no bundled npm package");
    ok(
      !valid.stderr.includes("cold-start crash"),
      "(8) unprefixed Node built-ins produce no missing-external finding",
    );

    const missing = runLint(
      scratchTree({
        ".vercel/output/functions/__server.func/index.mjs": `${entry}\nimport "actual-missing-external";\n`,
      }),
    );
    ok(missing.code === 1, "(8) a real missing npm external still exits 1");
    ok(
      missing.stderr.includes('"actual-missing-external" is imported but not present'),
      "(8) the output pass still names the real missing npm external",
    );
    for (const specifier of builtins) {
      ok(
        !missing.stderr.includes(`"${specifier}" is imported but not present`),
        `(8) ${specifier} is not reported beside a real missing package`,
      );
    }
  }

  console.log(`✓ hosted-externals source pass: ${passed} assertions`);
} finally {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
}
