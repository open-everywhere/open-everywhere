import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageReportLines, legBoardLines, parseLegsJson, parseLegsBoard } from "./coverage-matrix-lib.js";
import { scanTree } from "./coverage-scan-lib.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = flag(argv, "--root") ?? REPO_ROOT;
  const scan = await scanTree(root);

  console.log("══ THE BOARD ══════════════════════════════════════════════════════════════════");
  console.log("");
  console.log("COVERAGE — inventory behaviour rows with a proof, per page.");
  console.log("");
  for (const line of coverageReportLines(scan.matrix)) console.log(line);
  for (const warning of scan.warnings) console.log(`⚠ ${warning}`);
  console.log("");
  console.log("LEGS — the last e2e pack, per surface.");
  console.log("");

  const legsPath = flag(argv, "--legs");
  const boardPath = flag(argv, "--board");
  if (legsPath === undefined && boardPath === undefined) {
    console.log("  not supplied. Pass `--legs <results.json>` or `--board <runner-output.txt>`.");
    console.log("  Without one, this board says nothing about the legs — it does not print zeros, which would read as a clean pack.");
    return;
  }
  const path = legsPath ?? (boardPath as string);
  if (!existsSync(path)) {
    console.error(`✗ board: ${path} does not exist.`);
    process.exit(1);
  }
  const text = readFileSync(path, "utf8");
  const legs = legsPath === undefined ? parseLegsBoard(text) : parseLegsJson(text);
  for (const line of legBoardLines(legs)) console.log(line);
}

await main();
