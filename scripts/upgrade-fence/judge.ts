import { PROTECTED_PATH_RULES, type ProtectedPathRule } from "./manifest.js";

export type UpgradeFenceVerdict = "pass" | "refuse";

export interface UpgradeFenceInput {
  readonly changedFiles: readonly string[];
}

export interface ProtectedHit {
  readonly file: string;
  readonly rule: ProtectedPathRule;
}

export interface UpgradeFenceResult {
  readonly verdict: UpgradeFenceVerdict;
  readonly hits: readonly ProtectedHit[];
}

export const OVERRIDE_REMEDY = "protected path — requires orchestrator review-and-override";

function matchesPath(file: string, entry: string): boolean {
  const f = file.toLowerCase();
  const e = entry.toLowerCase();
  return e.endsWith("/") ? f.startsWith(e) : f === e;
}

export function ruleFor(file: string): ProtectedPathRule | undefined {
  return PROTECTED_PATH_RULES.find((rule) => rule.paths.some((p) => matchesPath(file, p)));
}

export function judgeUpgradeDiff(input: UpgradeFenceInput): UpgradeFenceResult {
  const hits: ProtectedHit[] = [];
  for (const file of input.changedFiles) {
    const rule = ruleFor(file);
    if (rule) hits.push({ file, rule });
  }
  return { verdict: hits.length === 0 ? "pass" : "refuse", hits };
}

export function formatUpgradeFenceReport(result: UpgradeFenceResult, fileCount: number): string[] {
  const lines: string[] = [];
  lines.push(`upgrade diff fence: ${fileCount} changed file(s)`);

  if (result.verdict === "pass") {
    lines.push("✓ no protected path changed");
    return lines;
  }

  const byRule = new Map<string, ProtectedHit[]>();
  for (const hit of result.hits) {
    const list = byRule.get(hit.rule.id) ?? [];
    list.push(hit);
    byRule.set(hit.rule.id, list);
  }
  for (const [id, list] of byRule) {
    lines.push(`  ${id} — ${list[0].rule.why}`);
    for (const hit of list) lines.push(`    ${hit.file}`);
  }

  lines.push(`✗ REFUSED: ${OVERRIDE_REMEDY}.`);
  lines.push("  The fence does not read who wrote this pull request. Every diff that touches a protected path refuses here.");
  lines.push("  To merge it, the orchestrator reviews the files above as a guardrail change and overrides this rung explicitly.");
  return lines;
}
