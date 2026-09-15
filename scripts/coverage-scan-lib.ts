import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import {
  parseInventoryRows,
  parseProvesAnnotations,
  soakCheckerAfter,
  buildMatrix,
  type InventoryRow,
  type ProvesClaim,
  type MatrixRow,
} from "./coverage-matrix-lib.js";

export const INVENTORY_DIR = join("docs", "inventory");
const SOAK_INVARIANTS = join("packages", "core", "scripts", "soak", "soak-invariants.ts");
const SCENARIOS_FILE = join("packages", "core", "scripts", "e2e", "scenarios.ts");
const TEST_FILE = /(?:\.test\.ts|-test\.ts|\.spec\.ts)$/u;

interface CoverageFixture {
  readonly scenarios?: readonly { readonly id: string; readonly proves?: readonly string[] }[];
  readonly auditActions?: readonly string[];
}

export interface CoverageScan {
  readonly matrix: readonly MatrixRow[];
  readonly claims: readonly ProvesClaim[];
  readonly warnings: readonly string[];
}

function inventoryFiles(root: string): readonly string[] {
  const dir = join(root, INVENTORY_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(INVENTORY_DIR, f));
}

function testFiles(root: string, isRepo: boolean): readonly string[] {
  if (isRepo) {
    const out = execFileSync("git", ["ls-files", "*.test.ts", "*-test.ts", "*.spec.ts"], { cwd: root, encoding: "utf8" });
    return out.split("\n").filter((f) => f !== "");
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (TEST_FILE.test(entry)) out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

function legFor(root: string, file: string): string | undefined {
  const manifests: readonly { readonly path: string; readonly suffix: string }[] = [
    { path: "package.json", suffix: "" },
    { path: join("packages", "core", "package.json"), suffix: " --workspace @open-everywhere/core" },
  ];
  for (const manifest of manifests) {
    const full = join(root, manifest.path);
    if (!existsSync(full)) continue;
    const scripts = (JSON.parse(readFileSync(full, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    const needle = manifest.suffix === "" ? file : file.replace(/^packages\/core\//u, "");
    for (const [name, body] of Object.entries(scripts)) {
      if (name === "test:chain") continue;
      if (body.includes(needle)) return `npm run ${name}${manifest.suffix}`;
    }
  }
  return undefined;
}

function unitClaims(root: string, isRepo: boolean): readonly ProvesClaim[] {
  const out: ProvesClaim[] = [];
  for (const file of testFiles(root, isRepo)) {
    const text = readFileSync(join(root, file), "utf8");
    if (!text.includes("proves:")) continue;
    const leg = legFor(root, file);
    for (const annotation of parseProvesAnnotations(text)) {
      out.push({
        ids: annotation.ids,
        source: file,
        line: annotation.line,
        kind: "unit",
        cell: leg === undefined ? file : `${file} (${leg})`,
      });
    }
  }
  return out;
}

function soakClaims(root: string, warnings: string[]): readonly ProvesClaim[] {
  const full = join(root, SOAK_INVARIANTS);
  if (!existsSync(full)) return [];
  const text = readFileSync(full, "utf8");
  const out: ProvesClaim[] = [];
  for (const annotation of parseProvesAnnotations(text)) {
    const checker = soakCheckerAfter(text, annotation.line);
    if (checker === undefined) {
      warnings.push(`${SOAK_INVARIANTS}:${annotation.line}: \`proves\` sits above no \`export function check…\` — the declaration names no checker and was dropped.`);
      continue;
    }
    out.push({ ids: annotation.ids, source: SOAK_INVARIANTS, line: annotation.line, kind: "soak", cell: checker });
  }
  return out;
}

async function repoScenariosAndActions(): Promise<{ claims: readonly ProvesClaim[]; actions: ReadonlySet<string> }> {
  const { SCENARIOS } = await import("../packages/core/scripts/e2e/scenarios.js");
  const { consequentialAuditActions, TEMPLATED_AUDIT_ACTIONS } = await import("../packages/core/agent/audit/action-registry.js");
  const claims: ProvesClaim[] = [];
  for (const scenario of SCENARIOS) {
    const proves = scenario.proves ?? [];
    if (proves.length === 0) continue;
    claims.push({ ids: proves, source: SCENARIOS_FILE, line: 0, kind: "e2e", cell: scenario.id });
  }
  const actions = new Set<string>();
  for (const declaration of consequentialAuditActions()) {
    if (declaration.notExercised !== undefined) continue;
    actions.add(declaration.action);
  }
  for (const templated of TEMPLATED_AUDIT_ACTIONS) {
    if (!templated.consequential || templated.notExercised !== undefined) continue;
    actions.add(templated.template);
  }
  return { claims, actions };
}

function fixtureScenariosAndActions(root: string): { claims: readonly ProvesClaim[]; actions: ReadonlySet<string> } {
  const path = join(root, "coverage-fixture.json");
  if (!existsSync(path)) return { claims: [], actions: new Set() };
  const fixture = JSON.parse(readFileSync(path, "utf8")) as CoverageFixture;
  const claims: ProvesClaim[] = [];
  for (const scenario of fixture.scenarios ?? []) {
    const proves = scenario.proves ?? [];
    if (proves.length === 0) continue;
    claims.push({ ids: proves, source: "coverage-fixture.json", line: 0, kind: "e2e", cell: scenario.id });
  }
  return { claims, actions: new Set(fixture.auditActions ?? []) };
}

export async function scanTree(root: string): Promise<CoverageScan> {
  const isRepo = existsSync(join(root, ".git"));
  const rows: InventoryRow[] = [];
  const warnings: string[] = [];
  for (const file of inventoryFiles(root)) {
    rows.push(...parseInventoryRows(readFileSync(join(root, file), "utf8"), file, warnings));
  }
  const { claims: scenarioClaims, actions } = isRepo ? await repoScenariosAndActions() : fixtureScenariosAndActions(root);
  const claims = [...unitClaims(root, isRepo), ...scenarioClaims, ...soakClaims(root, warnings)];
  return { matrix: buildMatrix(rows, claims, actions), claims, warnings };
}
