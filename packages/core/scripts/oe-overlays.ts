import { checkOverlays, normalizeOverlays, OVERLAYS } from "../agent/scaffold/overlay-check.js";
import { CONFIG_FILE, findRepoRoot } from "../agent/scaffold/roster-fs.js";

export interface OverlaysIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export function overlayCheckLines(repoRoot: string): { readonly ok: boolean; readonly problems: readonly string[]; readonly notes: readonly string[] } {
  const r = checkOverlays(repoRoot, { missing: "skip" });
  return {
    ok: r.problems.length === 0,
    problems: r.problems.map((p) => `OVERLAY · ${p}`),
    notes: r.staleHeaders.map((p) => `  · ${p}: older header text (not a failure) — \`npx oe overlays normalize\` refreshes it`),
  };
}

export function runOverlaysCommand(args: readonly string[], io: OverlaysIo, cwd: string): number {
  const action = args[0];
  if (action !== "check" && action !== "normalize") {
    io.err(`oe overlays: expected \`check\` or \`normalize\`, got ${action === undefined ? "nothing" : `"${action}"`}.`);
    return 2;
  }
  const repoRoot = findRepoRoot(cwd);
  if (repoRoot === undefined) {
    io.err(`✗ oe overlays: no ${CONFIG_FILE} found in ${cwd} or any parent directory.`);
    return 1;
  }

  if (action === "check") {
    const r = checkOverlays(repoRoot, { missing: "problem" });
    if (r.problems.length > 0) {
      io.err(`✗ oe overlays check: ${r.problems.length} problem(s) in the machine-owned config overlays.`);
      for (const p of r.problems) io.err(`  - ${p}`);
      io.err("  These files are MACHINE-OWNED data modules. Edit only the data, then run: npx oe overlays normalize");
      return 1;
    }
    for (const p of r.staleHeaders) io.out(`  · ${p}: older header text (not a failure) — \`npx oe overlays normalize\` refreshes it`);
    io.out(`✓ oe overlays check: ${r.checked} machine-owned overlay(s) hold only data: no executable code, and the data re-emits identically below the header.`);
    return 0;
  }

  const r = normalizeOverlays(repoRoot);
  if (r.problems.length > 0) {
    io.err(`✗ oe overlays normalize: ${r.problems.length} problem(s).`);
    for (const p of r.problems) io.err(`  - ${p}`);
    io.err("  Fix the reported file(s) by hand — normalisation can re-format data, it cannot remove code or repair a broken shape.");
    return 1;
  }
  io.out(
    r.wrote.length === 0
      ? `✓ oe overlays normalize: already canonical (${OVERLAYS.length} checked).`
      : `✓ oe overlays normalize: re-emitted ${r.wrote.length} overlay(s): ${r.wrote.join(", ")}. Commit the result.`,
  );
  return 0;
}
