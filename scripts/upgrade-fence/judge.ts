import { PROTECTED_PATH_RULES, UPGRADE_MARKER_RE, type ProtectedPathRule } from "./manifest.js";

export type UpgradeFenceVerdict = "pass" | "warn" | "refuse";

export interface UpgradeFenceInput {
  readonly changedFiles: readonly string[];
  readonly authorType: string;
  readonly authorLogin: string;
  readonly title: string;
  readonly body: string;
}

export interface ProtectedHit {
  readonly file: string;
  readonly rule: ProtectedPathRule;
}

export interface UpgradeFenceResult {
  readonly verdict: UpgradeFenceVerdict;
  readonly agentAuthored: boolean;
  readonly armedBy: readonly ("bot-author" | "upgrade-marker")[];
  readonly hits: readonly ProtectedHit[];
}

function matchesPath(file: string, entry: string): boolean {
  const f = file.toLowerCase();
  const e = entry.toLowerCase();
  return e.endsWith("/") ? f.startsWith(e) : f === e;
}

export function ruleFor(file: string): ProtectedPathRule | undefined {
  return PROTECTED_PATH_RULES.find((rule) => rule.paths.some((p) => matchesPath(file, p)));
}

export function isBotAuthor(authorType: string, authorLogin: string): boolean {
  return authorType.toLowerCase() === "bot" || /\[bot\]$/i.test(authorLogin.trim());
}

export function judgeUpgradeDiff(input: UpgradeFenceInput): UpgradeFenceResult {
  const armedBy: ("bot-author" | "upgrade-marker")[] = [];
  if (isBotAuthor(input.authorType, input.authorLogin)) armedBy.push("bot-author");
  if (UPGRADE_MARKER_RE.test(`${input.title}\n${input.body}`)) armedBy.push("upgrade-marker");

  const hits: ProtectedHit[] = [];
  for (const file of input.changedFiles) {
    const rule = ruleFor(file);
    if (rule) hits.push({ file, rule });
  }

  const agentAuthored = armedBy.length > 0;
  const verdict: UpgradeFenceVerdict = hits.length === 0 ? "pass" : agentAuthored ? "refuse" : "warn";
  return { verdict, agentAuthored, armedBy, hits };
}

export function formatUpgradeFenceReport(result: UpgradeFenceResult, fileCount: number): string[] {
  const lines: string[] = [];
  const who = result.agentAuthored ? `agent-authored (armed by: ${result.armedBy.join(", ")})` : "person-authored";
  lines.push(`upgrade diff fence: ${fileCount} changed file(s), ${who}`);

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

  if (result.verdict === "warn") {
    lines.push("⚠ this pull request changes the access plane. It is person-authored, so the fence does not refuse it —");
    lines.push("  review the files above as a guardrail change, not as an ordinary diff.");
    return lines;
  }
  lines.push("✗ REFUSED. An agent-authored pull request must not change a protected path.");
  lines.push("  The upgrade path is version bumps plus declared migrations, never an edit to the agent's own guardrails.");
  lines.push("  A real guardrail change goes in its own hand-written pull request, opened by a person.");
  return lines;
}
