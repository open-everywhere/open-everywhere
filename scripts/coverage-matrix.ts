import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findings, isCovered, coverageReportLines } from "./coverage-matrix-lib.js";
import { scanTree, INVENTORY_DIR } from "./coverage-scan-lib.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag === -1 ? REPO_ROOT : (argv[rootFlag + 1] ?? REPO_ROOT);
  const scan = await scanTree(root);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ matrix: scan.matrix, warnings: scan.warnings }, null, 2));
    return;
  }

  console.log("Coverage matrix — inventory rows joined to the code that proves them.");
  console.log("");
  for (const line of coverageReportLines(scan.matrix)) console.log(line);
  for (const warning of scan.warnings) console.log(`⚠ ${warning}`);

  if (!argv.includes("--check")) return;

  if (scan.matrix.length === 0) {
    console.error(`✗ coverage matrix: no inventory row parsed under ${join(root, INVENTORY_DIR)}. The scanner found nothing to rule on, which is a broken scan, never a covered tree.`);
    process.exit(1);
  }
  if (scan.claims.length === 0) {
    console.error("✗ coverage matrix: no `proves` declaration found anywhere in the tree. Every annotation cannot have been deleted at once, so the scanner broke.");
    process.exit(1);
  }

  const found = findings(scan.matrix, scan.claims);
  if (found.length === 0) {
    const covered = scan.matrix.filter(isCovered).length;
    const pending = scan.matrix.filter((e) => e.na?.pending === true).length;
    const exempt = scan.matrix.filter((e) => e.na !== undefined && e.na.pending === false).length;
    console.log(`✓ coverage matrix: ${scan.matrix.length} rows, ${covered} covered, ${exempt} exempt, ${pending} PENDING (n/a: unannotated — unanswered, not exempt).`);
    return;
  }
  console.error("");
  console.error(`✗ coverage matrix: ${found.length} finding(s).`);
  for (const finding of found.slice(0, 50)) {
    console.error(`  ${finding.file}:${finding.line}: [${finding.kind}] ${finding.message}`);
  }
  if (found.length > 50) console.error(`  … and ${found.length - 50} more.`);
  process.exit(1);
}

await main();
