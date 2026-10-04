export function runChain(legs: readonly string[], run: (leg: string) => number | null, log: (line: string) => void): number {
  for (const [i, leg] of legs.entries()) {
    const code = run(leg);
    if (code !== 0) {
      log(`✗ test:chain: "${leg}" failed (exit ${code ?? "signal"}) — leg ${i + 1} of ${legs.length}; the legs after it did not run.`);
      return code ?? 1;
    }
  }
  log(`✓ test:chain: ${legs.length} leg(s) passed.`);
  return 0;
}
