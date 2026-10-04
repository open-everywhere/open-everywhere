import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OVERLAYS, checkOverlays, normalizeOverlays } from "@open-everywhere/core/agent/scaffold/overlay-check.js";

const rootFlagAt = process.argv.indexOf("--root");
const root =
  rootFlagAt >= 0 && process.argv[rootFlagAt + 1] !== undefined
    ? process.argv[rootFlagAt + 1]
    : join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const problems: string[] = [];
let wrote: readonly string[] = [];
let staleHeaders: readonly string[] = [];

if (check) {
  const r = checkOverlays(root, { missing: "problem" });
  problems.push(...r.problems);
  staleHeaders = r.staleHeaders;
} else {
  const r = normalizeOverlays(root);
  problems.push(...r.problems);
  wrote = r.wrote;
}

const EVE_MEMORY_SLOT_DIR = "agent/memory";
const AUTHORED_EVE_MEMORY_SLOTS: readonly string[] = [];
if (existsSync(join(root, EVE_MEMORY_SLOT_DIR))) {
  const strays = readdirSync(join(root, EVE_MEMORY_SLOT_DIR), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(?:ts|mts|js|mjs)$/u.test(e.name))
    .map((e) => e.name)
    .filter((name) => !AUTHORED_EVE_MEMORY_SLOTS.includes(name));
  if (strays.length > 0) {
    problems.push(
      `${EVE_MEMORY_SLOT_DIR}/ holds ${strays.length} module(s) eve will read as authored memory slots: ${strays.join(", ")}. ` +
        `eve discovers every module directly inside that directory and requires a \`defineMemory()\` default export, so ` +
        `the build fails with "Expected the memory export …". OE's memory CONFIGURATION belongs in ` +
        `${EVE_MEMORY_SLOT_DIR}/config/ (eve's scan is not recursive); only a real memory provider belongs here, and it ` +
        `must be listed in AUTHORED_EVE_MEMORY_SLOTS in this file.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`✗ machine-owned config overlays (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    check
      ? "  These files are MACHINE-OWNED data modules. Edit only the data, then run: npm run overlays:normalize"
      : "  Fix the reported file(s) by hand — normalisation can re-format data, it cannot remove code or repair a broken shape.",
  );
  process.exit(1);
}

if (check) {
  for (const p of staleHeaders) console.log(`  · ${p}: older header text (not a failure) — \`npm run overlays:normalize\` refreshes it`);
  console.log(`✓ config overlays are canonical data — ${OVERLAYS.length} machine-owned module(s) re-emit byte-identically below the header (no executable code, data canonical)`);
} else {
  console.log(wrote.length === 0 ? `✓ config overlays already canonical (${OVERLAYS.length} checked)` : `✓ normalised ${wrote.length} overlay(s): ${wrote.join(", ")}`);
}
