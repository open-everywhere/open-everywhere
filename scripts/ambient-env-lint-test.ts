import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AMBIENT_READ_MANIFEST,
  PASS_THROUGH,
  auditLegReads,
  auditManifestShape,
  codeOnly,
  declarationKey,
  envUseIn,
  WHOLE_ENV,
  type DeclaredRead,
  type LegSource,
} from "./ambient-env-manifest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(root, "scripts", "ambient-env-lint.ts");
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

const scratchRoots: string[] = [];

function fixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oe-ambient-env-"));
  scratchRoots.push(dir);
  const file = join(dir, "probe.ts");
  writeFileSync(file, `${body}\n`);
  return file;
}

function lint(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, LINT, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function lintBody(body: string): { code: number; out: string } {
  return lint("--only", fixture(body));
}

function synthetic(entries: Record<string, DeclaredRead>): ReadonlyMap<string, DeclaredRead> {
  return new Map(Object.entries(entries));
}

function legOf(file: string, source: string): LegSource {
  return { label: `<test> ${file}`, file, source };
}

const PROBE = `OE_AMBIENT_${"PROBE"}`;

function main(): void {
  {
    const r = lintBody(`export const v = process.env.${PROBE};`);
    ok(r.code !== 0, `an unpinned ambient read fails the lint (exit ${r.code})`);
    ok(r.out.includes("AMBIENT ENV READ"), "…under the per-leg arm's own headline, not another arm's");
    ok(r.out.includes(PROBE), "…naming the variable that caused it");
    ok(r.out.includes("probe.ts:1"), "…and the file and line that read it, so the author has somewhere to go");
    ok(r.out.includes("PIN the variable"), "…and the remedy is printed once, under the list");
  }

  {
    const r = lintBody(`process.env.${PROBE} = "1";\nexport const v = process.env.${PROBE};`);
    ok(r.code === 0, `a suite that sets the variable it reads is silent (exit ${r.code}: ${r.out})`);
    ok(!r.out.includes("AMBIENT ENV READ"), "…with no per-leg red at all");
  }

  {
    const r = lintBody(`delete process.env.${PROBE};\nexport const v = process.env.${PROBE};`);
    ok(r.code === 0, `deleting the variable counts as pinning it (exit ${r.code}: ${r.out})`);
  }

  {
    const r = lintBody(`process.env.${PROBE} ??= "1";\nexport const v = process.env.${PROBE};`);
    ok(r.code !== 0, `a \`??=\` default does NOT count as a pin (exit ${r.code})`);
    ok(r.out.includes("AMBIENT ENV READ"), "…and reds under the per-leg arm");
    ok(lintBody(`process.env.${PROBE} = "1";\nexport const v = process.env.${PROBE};`).code === 0, "…while `=` clears it");
  }

  {
    ok(lintBody(`export const v = process.env.PATH;`).code === 0, "a PASS_THROUGH name needs no pin");
    ok(lintBody(`export const v = process.env.${PROBE};`).code !== 0, "…while an unexempt name in the same shape reds");
  }

  {
    const r = lintBody(`export const v = Object.entries(process.env).length;`);
    ok(r.code !== 0, `inspecting process.env as a whole value reds (exit ${r.code})`);
    ok(r.out.includes("AMBIENT WHOLE-ENV READ"), "…under the whole-env arm's own headline");
    const spread = lintBody(`export const v = { ...process.env, OE_X: "1" };`);
    ok(spread.code === 0, `spreading it into a child's env is the pass-through shape and is silent (${spread.out})`);
  }

  {
    const body = [
      `// a line comment mentioning process.env.${PROBE}`,
      `/* a block comment mentioning process.env.${PROBE} */`,
      `export const fixture = "console.log(process.env.${PROBE})";`,
      `export const tpl = \`process.env.${PROBE}\`;`,
      `export const re = /["']process\\.env\\.${PROBE}["']/;`,
    ].join("\n");
    const r = lintBody(body);
    ok(r.code === 0, `a name only MENTIONED in a comment, string, template or regex is not a read (${r.out})`);
    ok(lintBody(`${body}\nexport const real = process.env.${PROBE};`).code !== 0, "…while one real read beside them reds");
  }

  {
    const loop = `const KEYS = ["OE_LOOPED"];\nfor (const k of KEYS) delete process.env[k];\n`;
    ok(lintBody(`${loop}export const v = process.env.OE_LOOPED;`).code === 0, "a restore loop pins the name it spells");
    const escaped = lintBody(`${loop}export const v = process.env.${PROBE};`);
    ok(escaped.code !== 0, `…and NOT a different name the same file never spells (exit ${escaped.code})`);
    ok(escaped.out.includes(PROBE), "…which is the name the red must point at");
  }

  {
    const r = lintBody(`export const v = \`value=\${process.env.${PROBE}}\`;`);
    ok(r.code !== 0, `a read inside a \${…} substitution is a read (exit ${r.code})`);
  }

  {
    const r = lint();
    ok(r.code === 0, `the gate is green on this tree (exit ${r.code}):\n${r.out}`);
    const m = /ambient-env: (\d+) chain-leg suite\(s\) scanned/.exec(r.out);
    ok(m !== null, `…and reports how many suites it scanned (got: ${r.out.trim()})`);
    ok(Number(m?.[1] ?? 0) > 400, `…which is the whole chain, not a handful (scanned ${m?.[1]})`);
  }

  {
    const src = `const a = 1; // process.env.A\nconst b = "process.env.B";\nconst c = process.env.C;\n`;
    const out = codeOnly(src);
    ok(out.length === src.length, "the blanked source is the same length as the input");
    ok(out.split("\n").length === src.split("\n").length, "…and holds the same number of lines");
    ok(!out.includes("process.env.A") && !out.includes("process.env.B"), "…with the comment and string reads gone");
    ok(out.includes("process.env.C"), "…and the real read still there — the negative control");
  }

  {
    for (const [what, src] of [
      ["after `=`", `const re = /["']x/;\nconst v = process.env.${PROBE};\n`],
      ["after a keyword", `export function f(x: string) { return /["']/.test(x) ? process.env.${PROBE} : ""; }\n`],
    ] as const) {
      ok(codeOnly(src).includes(`process.env.${PROBE}`), `a lone quote in a regex class ${what} does not blank the code after it`);
    }
    const divided = codeOnly(`const a = 4;\nconst b = a / 2;\nconst v = process.env.${PROBE};\n`);
    ok(divided.includes(`process.env.${PROBE}`) && divided.includes("a / 2"), "…and a division is still a division");
  }

  {
    ok(envUseIn(`import { env } from "node:process";\nconst v = env.OE_X;`).aliasedEnv.length === 1, "an `env` import from node:process is named");
    ok(envUseIn(`const v = process["env"].OE_X;`).aliasedEnv.length === 1, "…and so is process[\"env\"]");
    ok(envUseIn(`const v = process.env.OE_X;`).aliasedEnv.length === 0, "…while the plain form is not an alias");
    ok(envUseIn(`import { chdir, cwd } from "node:process";`).aliasedEnv.length === 0, "…and neither is an import that does not name `env`");
    const r = lintBody(`import { env } from "node:process";\nexport const v = env.${PROBE};`);
    ok(r.code !== 0 && r.out.includes("ALIASED ENV ACCESS"), `…and the alias reds through the real CLI (exit ${r.code})`);
  }

  {
    const read = envUseIn(`const v = process.env.A;`);
    ok(read.reads.has("A") && read.pins.size === 0, "a bare read is a read and not a pin");

    const pinned = envUseIn(`process.env.A = "1";\nconst v = process.env.A;`);
    ok(!pinned.reads.has("A") && pinned.pins.has("A"), "…while a file that assigns it has pinned it");

    const defaulted = envUseIn(`process.env.A ??= "1";`);
    ok(defaulted.reads.has("A") && !defaulted.pins.has("A"), "a `??=` default is a read, never a pin");
    ok(envUseIn(`process.env.A ||= "1";`).reads.has("A"), "…and so is `||=`");

    const bracket = envUseIn(`const v = process.env["A"];`);
    ok(bracket.reads.has("A"), "a quoted bracket read is the same read as a dotted one");

    const dynamic = envUseIn(`const KEYS = ["OE_ONE"];\nfor (const k of KEYS) delete process.env[k];\nconst v = process.env.OE_ONE;`);
    ok(dynamic.dynamicPin, "a delete through a variable key is a dynamic pin — the save-and-restore shape");
    ok(dynamic.dynamicPins.has("OE_ONE"), "…credited with the env-shaped literals the file spells");
    ok(!envUseIn(`const v = process.env.OE_ONE;`).dynamicPin, "…and a file without one is not — the negative control");

    ok(envUseIn(`Object.keys(process.env);`).wholeEnv.length === 1, "using process.env as a value is a whole-env read");
    ok(envUseIn(`const e = { ...process.env };`).wholeEnv.length === 0, "…and spreading it is not");
    ok(envUseIn(`const v = process.env.A;`).wholeEnv.length === 0, "…and neither is an ordinary property read");
  }

  {
    const leg = legOf("scratch/probe.ts", `const v = process.env.A;`);
    ok(auditLegReads([leg], new Map(), PASS_THROUGH).reds.length === 1, "an undeclared read is one red");
    const declared = synthetic({
      [declarationKey("scratch/probe.ts", "A")]: { klass: "deliberate", why: "the host's own value is the subject here." },
    });
    ok(auditLegReads([leg], declared, PASS_THROUGH).reds.length === 0, "…and declaring it clears the red");
    const other = legOf("scratch/other.ts", `const v = process.env.A;`);
    ok(auditLegReads([other], declared, PASS_THROUGH).reds.length === 1, "…for that file only, never for another one");
  }

  {
    const clean = auditLegReads([legOf("scratch/probe.ts", `const v = process.env.A;`)], new Map(), new Map());

    const stale = synthetic({ "scratch/gone.ts A": { klass: "deliberate", why: "a read nothing performs any more." } });
    const staleReds = auditManifestShape(clean, stale, new Map());
    ok(staleReds.length === 1 && staleReds[0]!.includes("STALE AMBIENT DECLARATION"), "a declaration no leg needs is a red");
    ok(staleReds[0]!.includes("scratch/gone.ts"), "…naming it");

    const live = synthetic({ "scratch/probe.ts A": { klass: "deliberate", why: "a read this tree really performs." } });
    ok(auditManifestShape(clean, live, new Map()).length === 0, "…and is silent while the read is still there");

    const bare = synthetic({ "scratch/probe.ts A": { klass: "deliberate", why: "because." } });
    const bareReds = auditManifestShape(clean, bare, new Map());
    ok(bareReds.length === 1 && bareReds[0]!.includes("UNREASONED"), "a declaration with no real reason is a red");

    const unticketed = synthetic({ "scratch/probe.ts A": { klass: "pending-fix", why: "we will pin this one later on." } });
    const untickReds = auditManifestShape(clean, unticketed, new Map());
    ok(untickReds.length === 1 && untickReds[0]!.includes("UNTICKETED PENDING FIX"), "a backlog entry naming no ticket is a red");
    const ticketed = synthetic({ "scratch/probe.ts A": { klass: "pending-fix", why: "OPE-1153 pins this one." } });
    ok(auditManifestShape(clean, ticketed, new Map()).length === 0, "…and naming one clears it — the negative control");
    const permanent = synthetic({ "scratch/probe.ts A": { klass: "deliberate", why: "we will pin this one later on." } });
    ok(auditManifestShape(clean, permanent, new Map()).length === 0, "…and a `deliberate` entry needs no ticket");

    const stalePass = auditManifestShape(clean, new Map(), new Map([["NOTHING_READS_ME", "a forwarded name."]]));
    ok(stalePass.length === 1 && stalePass[0]!.includes("STALE PASS-THROUGH"), "a pass-through name nothing reads is a red");
    const readPass = auditLegReads([legOf("scratch/probe.ts", `const v = process.env.A;`)], new Map(), new Map([["A", "forwarded."]]));
    ok(auditManifestShape(readPass, new Map(), new Map([["A", "forwarded."]])).length === 0, "…and is silent while a leg reads it");
  }

  {
    ok(AMBIENT_READ_MANIFEST.size === 6, `the manifest holds 6 declared read(s) (found ${AMBIENT_READ_MANIFEST.size})`);
    ok(PASS_THROUGH.size === 2, `PASS_THROUGH holds 2 name(s) (found ${PASS_THROUGH.size})`);

    const unticketed = [...AMBIENT_READ_MANIFEST].filter(([, e]) => e.klass === "pending-fix" && !/OPE-\d+/.test(e.why));
    ok(unticketed.length === 0, `every real backlog entry names a ticket (unticketed: ${unticketed.map(([k]) => k).join(", ")})`);
    const reasonless = [...AMBIENT_READ_MANIFEST].filter(([, e]) => e.why.trim().length < 20);
    ok(reasonless.length === 0, `every real entry carries a reason (bare: ${reasonless.map(([k]) => k).join(", ")})`);

    for (const key of AMBIENT_READ_MANIFEST.keys()) {
      const [file, name, ...rest] = key.split(" ");
      ok(
        rest.length === 0 && file !== undefined && name !== undefined && file.endsWith(".ts"),
        `manifest key "${key}" is \`<repo-relative .ts file> <NAME>\` — build it with declarationKey()`,
      );
    }
    ok(
      [...AMBIENT_READ_MANIFEST.keys()].filter((k) => k.endsWith(` ${WHOLE_ENV}`)).length === 5,
      "5 of the 6 declarations are whole-environment reads — if you meant to change this, say so here",
    );
  }
}

try {
  main();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  (${passed} assertion(s) passed before the failure)`);
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });

console.log(
  `\n✓ ambient-env guard: ${passed} assertions passed ` +
    `(${AMBIENT_READ_MANIFEST.size} declared read(s), ${PASS_THROUGH.size} pass-through name(s))\n`,
);
