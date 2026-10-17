import { laneDeclarationProblems, renderLaneDeclarationProblems } from "../packages/core/scripts/e2e/lanes.js";

const lines = renderLaneDeclarationProblems(laneDeclarationProblems());
if (lines.length > 0) {
  for (const line of lines) console.error(`✗ lint:e2e-lanes: ${line}`);
  console.error("  Add or fix the leg's row in packages/core/scripts/e2e/lanes.ts.");
  process.exit(1);
}
console.log("✓ lint:e2e-lanes: every e2e leg declares its lane");
