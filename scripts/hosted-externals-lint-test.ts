import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isGeneratedDocsPage } from "./hosted-externals-source-scan.js";
import { finishedRun } from "./npm-command.js";

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
  return { code: finishedRun(r, "the hosted-externals lint").status, stderr: `${r.stderr ?? ""}${r.stdout ?? ""}` };
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

  {
    const FUNC = ".vercel/output/functions/__server.func";
    const STUB = 'export * from "./chunks/server.mjs";\n';
    const stub = runLint(
      scratchTree({ [`${FUNC}/index.mjs`]: STUB, [`${FUNC}/chunks/server.mjs`]: 'import "@workflow/serde";\n' }),
    );
    ok(stub.code === 1, "(9) 🔴 an unresolvable import that sits only in a chunk exits 1");
    ok(
      stub.stderr.includes('__server.func/chunks/server.mjs: "@workflow/serde" is imported but not present'),
      "(9) the finding names the chunk and the package",
    );

    const traced = runLint(
      scratchTree({
        [`${FUNC}/index.mjs`]: STUB,
        [`${FUNC}/chunks/server.mjs`]: 'import "@workflow/serde";\n',
        [`${FUNC}/node_modules/@workflow/serde/package.json`]: "{}\n",
      }),
    );
    ok(traced.code === 0, "(9) control: the chunk's import resolves from the function's node_modules");
    ok(traced.stderr.includes("1 bare import(s) in 2 module file(s)"), "(9) both module files are read");

    const outside = runLint(
      scratchTree({
        [`${FUNC}/index.mjs`]: STUB,
        [`${FUNC}/chunks/server.mjs`]: 'import "@workflow/serde";\n',
        ".vercel/output/functions/node_modules/@workflow/serde/package.json": "{}\n",
      }),
    );
    ok(outside.code === 1, "(9) a package above the function directory does not resolve it");
    ok(
      outside.stderr.includes('__server.func/chunks/server.mjs: "@workflow/serde" is imported but not present'),
      "(9) the bound's finding is the unresolved package, not some other failure",
    );

    const cjsFiles = {
      [`${FUNC}/index.mjs`]: STUB,
      [`${FUNC}/chunks/server.mjs`]: 'import { createRequire } from "node:module";\nconst __require = createRequire(import.meta.url);\nexport const s = __require("ghost-shim");\n',
      [`${FUNC}/chunks/legacy.cjs`]: 'module.exports = require("ghost-cjs");\n',
      [`${FUNC}/chunks/tpl.cjs`]: "module.exports = require(`ghost-tpl`);\n",
    };
    const cjs = runLint(scratchTree(cjsFiles));
    ok(cjs.code === 1, "(9) an untraced require() exits 1");
    ok(cjs.stderr.includes('chunks/legacy.cjs: "ghost-cjs"'), "(9) a .cjs file's require() is judged");
    ok(cjs.stderr.includes('chunks/server.mjs: "ghost-shim"'), "(9) a __require() shim call is judged");
    ok(cjs.stderr.includes('chunks/tpl.cjs: "ghost-tpl"'), "(9) a backtick require() argument is judged");
    const cjsTraced = runLint(
      scratchTree({
        ...cjsFiles,
        [`${FUNC}/node_modules/ghost-shim/package.json`]: "{}\n",
        [`${FUNC}/node_modules/ghost-cjs/package.json`]: "{}\n",
        [`${FUNC}/node_modules/ghost-tpl/package.json`]: "{}\n",
      }),
    );
    ok(cjsTraced.code === 0, "(9) control: traced require() targets are green");

    {
      const inside = scratchTree({
        [`${FUNC}/index.mjs`]: STUB,
        [`${FUNC}/chunks/server.mjs`]: "export {};\n",
        [`${FUNC}/zzz/mod.mjs`]: 'import "ghost-linked";\n',
      });
      mkdirSync(join(inside, FUNC, "sub"));
      symlinkSync(join(inside, FUNC, "zzz"), join(inside, FUNC, "sub", "link"), "dir");
      const followed = runLint(inside);
      ok(followed.code === 1, "(9) a module file behind a directory symlink is judged");
      ok(followed.stderr.includes(': "ghost-linked" is imported'), "(9) the linked file's import reds");

      mkdirSync(join(inside, FUNC, "sub", "node_modules", "ghost-linked"), { recursive: true });
      ok(runLint(inside).code === 1, "(9) a package beside the link does not resolve the real file");
      mkdirSync(join(inside, FUNC, "zzz", "node_modules", "ghost-linked"), { recursive: true });
      ok(runLint(inside).code === 0, "(9) control: a package beside the real file resolves it");

      const outsideLink = scratchTree({
        [`${FUNC}/index.mjs`]: STUB,
        [`${FUNC}/chunks/server.mjs`]: "export {};\n",
        "linked/real/mod.mjs": "export {};\n",
      });
      symlinkSync(join(outsideLink, "linked", "real"), join(outsideLink, FUNC, "packages"), "dir");
      const out = runLint(outsideLink);
      ok(out.code === 1, "(9) a link out of the function directory exits 1");
      ok(
        out.stderr.includes("__server.func/packages/mod.mjs: links outside the function directory"),
        "(9) the finding names the linked file",
      );

      const cycle = scratchTree({ [`${FUNC}/index.mjs`]: "export {};\n" });
      symlinkSync(join(cycle, FUNC), join(cycle, FUNC, "loop"), "dir");
      ok(runLint(cycle).code === 0, "(9) a link cycle ends green");

      const twice = scratchTree({ [`${FUNC}/index.mjs`]: STUB, [`${FUNC}/chunks/server.mjs`]: "export {};\n" });
      symlinkSync(join(twice, FUNC, "chunks", "server.mjs"), join(twice, FUNC, "chunks", "alias.mjs"));
      const once = runLint(twice);
      ok(once.code === 0, "(9) a linked file inside the function is green");
      ok(once.stderr.includes("in 2 module file(s)"), "(9) a file reached by two paths is judged once");

      const dangling = scratchTree({ [`${FUNC}/index.mjs`]: STUB, [`${FUNC}/chunks/server.mjs`]: "export {};\n" });
      symlinkSync(join(dangling, "nowhere.mjs"), join(dangling, FUNC, "chunks", "gone.mjs"));
      const gone = runLint(dangling);
      ok(gone.code === 1, "(9) a dangling module link exits 1");
      ok(gone.stderr.includes("chunks/gone.mjs: is a dangling link"), "(9) the finding names the dangling link");
    }

    const lazy = runLint(
      scratchTree({
        [`${FUNC}/index.mjs`]: 'export const load = () => import("./chunks/lazy.mjs");\n',
        [`${FUNC}/chunks/lazy.mjs`]: 'export const m = await import("ghost-lazy");\n',
      }),
    );
    ok(lazy.code === 1, "(9) a lazily loaded chunk's dynamic import is judged");
    ok(lazy.stderr.includes('chunks/lazy.mjs: "ghost-lazy"'), "(9) the finding names the lazy chunk");

    const prose = runLint(
      scratchTree({
        [`${FUNC}/index.mjs`]: STUB,
        [`${FUNC}/chunks/server.mjs`]:
          '// import "ghost-comment";\nexport const s = `\nimport "ghost-string";\n`;\n',
      }),
    );
    ok(prose.code === 0, "(9) a package name in a comment or a string is not a finding");

    const traced2 = runLint(
      scratchTree({
        [`${FUNC}/index.mjs`]: 'import "pkg";\n',
        [`${FUNC}/node_modules/pkg/index.js`]: 'import "pkg-own-dep";\n',
      }),
    );
    ok(traced2.code === 0, "(9) files under node_modules are not read");

    const broken = runLint(
      scratchTree({ [`${FUNC}/index.mjs`]: STUB, [`${FUNC}/chunks/server.mjs`]: "import {\n" }),
    );
    ok(broken.code === 1, "(9) an unparseable chunk exits 1");
    ok(broken.stderr.includes("chunks/server.mjs: cannot be parsed"), "(9) the finding names the file");
  }

  {
    const FUNC = ".vercel/output/functions/__server.func";
    const one = (body: string) =>
      runLint(scratchTree({ [`${FUNC}/index.mjs`]: 'export * from "./_libs/eve.mjs";\n', [`${FUNC}/_libs/eve.mjs`]: body }));
    const EVE =
      'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n' +
      "export function captureOptionalPeerTracerProxy() {\n" +
      '  try {\n    let e = require("@opentelemetry/api"), t = e.trace.getTracerProvider();\n    return t;\n' +
      "  } catch { return; }\n}\n";
    const eve = one(EVE);
    ok(eve.code === 0, "(10) 🔴 eve's try/catch-guarded require is green");
    ok(
      eve.stderr.includes('note: __server.func/_libs/eve.mjs: "@opentelemetry/api" is absent, but a catch guards its load.'),
      "(10) the guarded load is printed as a note",
    );
    ok(eve.stderr.includes("1 guarded optional load(s) not judged"), "(10) the summary counts the guarded load");

    const red = (label: string, body: string) => {
      const r = one(body);
      ok(r.code === 1, `(10) ${label} exits 1`);
      ok(r.stderr.includes('"ghost-opt" is imported but not present'), `(10) ${label} names the package`);
      ok(!r.stderr.includes("note:"), `(10) ${label} is a finding, not a guarded note`);
    };
    red("an unguarded require", 'module.exports = require("ghost-opt");\n');
    red("a require in the catch", 'try { x(); } catch { require("ghost-opt"); }\n');
    red("a require in the finally", 'try { x(); } catch {} finally { require("ghost-opt"); }\n');
    red("a try with no catch", 'try { require("ghost-opt"); } finally {}\n');
    red("a catch that rethrows", 'try { require("ghost-opt"); } catch (e) { if (e) throw e; }\n');
    red("a callback defined in the try", 'try { setTimeout(() => require("ghost-opt")); } catch {}\n');
    red("a function declared in the try", 'try { function h() { require("ghost-opt"); } } catch {}\n');
    red("a function expression in the try", 'try { const h = function () { require("ghost-opt"); }; } catch {}\n');
    red("a class body defined in the try", 'try { class A { m = require("ghost-opt"); } } catch {}\n');
    red("a dynamic import not awaited", 'try { import("ghost-opt"); } catch {}\n');
    red("the same package also loaded unguarded", 'try { require("ghost-opt"); } catch {}\nrequire("ghost-opt");\n');
    red("an unguarded static import beside a guarded load", 'import "ghost-opt";\ntry { require("ghost-opt"); } catch {}\n');

    const own = one(
      'try { x(); } catch {}\nexport const f = () => { try { return require("ghost-opt"); } catch { return undefined; } };\n' +
        'export async function g() { try { return await (import("ghost-lazy")); } catch { return undefined; } }\n' +
        'export async function k() { try { return await import("ghost-plain"); } catch { return undefined; } }\n',
    );
    ok(own.code === 0, "(10) a function's own try/catch guards its require and its awaited imports");
    ok(own.stderr.includes("3 guarded optional load(s) not judged"), "(10) all three guarded loads are counted");

    const deferredThrow = one('try { require("ghost-opt"); } catch (e) { const f = () => { throw e; }; }\n');
    ok(deferredThrow.code === 0, "(10) a throw in a nested function of the catch is not a rethrow");
    ok(deferredThrow.stderr.includes('"ghost-opt" is absent, but a catch guards its load.'), "(10) its load is a note");

    const present = runLint(
      scratchTree({
        [`${FUNC}/index.mjs`]: EVE,
        [`${FUNC}/node_modules/@opentelemetry/api/package.json`]: "{}\n",
      }),
    );
    ok(present.code === 0, "(10) control: a traced guarded load is green");
    ok(!present.stderr.includes("note:"), "(10) a traced guarded load makes no note");
  }

  console.log(`✓ hosted-externals source and output passes: ${passed} assertions`);
} finally {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
}
