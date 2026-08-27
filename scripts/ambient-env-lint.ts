import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  AMBIENT_READ_MANIFEST,
  AMBIENT_READ_REMEDY,
  PASS_THROUGH,
  auditLegReads,
  auditManifestShape,
  envUseIn,
  type LegSource,
} from "./ambient-env-manifest.js";
import { REPO_ROOT, chainLegs, legLabel } from "./chain/_legs.js";

const argv = process.argv.slice(2);
const listMode = argv.includes("--list");
const onlyAt = argv.indexOf("--only");
const onlyFiles = onlyAt === -1 ? [] : argv.slice(onlyAt + 1).filter((a) => !a.startsWith("--"));

if (onlyAt !== -1 && onlyFiles.length === 0) {
  console.error("✗ ambient-env: --only needs at least one file path.");
  process.exit(1);
}

function chainLegSources(): LegSource[] {
  const byFile = new Map<string, LegSource>();
  for (const leg of chainLegs()) {
    const file = relative(REPO_ROOT, leg.file);
    if (byFile.has(file)) continue;
    byFile.set(file, { label: legLabel(leg), file, source: readFileSync(leg.file, "utf8") });
  }
  return [...byFile.values()];
}

function namedSources(paths: readonly string[]): LegSource[] {
  return paths.map((p) => {
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
    const file = relative(REPO_ROOT, abs);
    return { label: `--only ${file}`, file, source: readFileSync(abs, "utf8") };
  });
}

const wholeChain = onlyFiles.length === 0;
const legs = wholeChain ? chainLegSources() : namedSources(onlyFiles);

if (listMode) {
  for (const leg of [...legs].sort((a, b) => a.file.localeCompare(b.file))) {
    const use = envUseIn(leg.source);
    if (use.reads.size === 0 && use.pins.size === 0 && use.wholeEnv.length === 0) continue;
    const parts: string[] = [];
    if (use.reads.size > 0) parts.push(`reads ${[...use.reads.keys()].sort().join(",")}`);
    if (use.pins.size > 0) parts.push(`pins ${[...use.pins].sort().join(",")}`);
    if (use.dynamicPin) parts.push(`pins through a variable key: ${[...use.dynamicPins].sort().join(",") || "no resolvable name"}`);
    if (use.wholeEnv.length > 0) parts.push(`whole-env x${use.wholeEnv.length}`);
    console.log(`  ${leg.file}\n      ${parts.join(" · ")}`);
  }
}

const audit = auditLegReads(legs);
const reds = [...audit.reds, ...(wholeChain ? auditManifestShape(audit) : [])];

if (reds.length > 0) {
  console.error(`✗ ambient-env: ${reds.length} problem(s) across ${legs.length} suite(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  console.error(`\n${AMBIENT_READ_REMEDY}`);
  process.exit(1);
}

if (!wholeChain) {
  console.log(`✓ ambient-env: ${legs.length} named suite(s) read no undeclared ambient environment.`);
} else {
  const pending = [...AMBIENT_READ_MANIFEST.values()].filter((e) => e.klass === "pending-fix").length;
  const pinning = legs.filter((l) => {
    const use = envUseIn(l.source);
    return use.pins.size > 0 || use.dynamicPin;
  }).length;
  console.log(
    `✓ ambient-env: ${legs.length} chain-leg suite(s) scanned — ${pinning} pin the environment they read, ` +
      `${PASS_THROUGH.size} name(s) exempt as pass-through, ${AMBIENT_READ_MANIFEST.size} declared read(s) ` +
      `(${pending} pending-fix, must only shrink), 0 undeclared ambient reads.`,
  );
}
