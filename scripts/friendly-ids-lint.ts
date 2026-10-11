import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SCOPE = /^(?:packages\/core\/agent|packages\/providers\/[^/]+\/agent)\//u;

export const RAW_FIELDS = [
  "requestedBy",
  "requesterPrincipalId",
  "principalId",
  "scopeKey",
  "surfaceKey",
  "workspaceKey",
  "fromContainer",
  "recipientId",
  "ownerNativeId",
  "ownerPrincipalId",
  "decidedBy",
  "actorId",
  "userId",
  "channelId",
] as const;

const RAW_TAIL = new RegExp(`(?:^|[.\\s(!?])(?:${RAW_FIELDS.join("|")})\\s*\\)?\\s*$`, "u");
const RAW_COMPOUND_TAIL = new RegExp(`[a-z](?:${RAW_FIELDS.map((f) => f[0]!.toUpperCase() + f.slice(1)).join("|")})\\s*\\)?\\s*$`, "u");
const RENDERED = /\b(?:personWords|placeWords|requesterWords|recipientWords|scopeWords|plainScope|friendlyScopeLabel)\s*\(/u;
const LOG_OR_THROW = /\bconsole\.|\b\w*log(?:Once)?\??\.?\s*\(|\bwarn\s*\(|\bError\s*\(|\bthrow\b|\bdebug\s*\(/u;

export interface RawIdHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export function rawIdHits(file: string, source: string): RawIdHit[] {
  const hits: RawIdHit[] = [];
  const lines = source.split("\n");
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (!text.includes("${")) return;
    if (LOG_OR_THROW.test(text)) return;
    if (/`\[open-everywhere:/u.test(text)) return;
    const re = /\$\{((?:[^{}]|\{[^{}]*\})*)\}/gu;
    for (const m of text.matchAll(re)) {
      const expr = m[1]!;
      if (RENDERED.test(expr)) continue;
      if (!RAW_TAIL.test(expr) && !RAW_COMPOUND_TAIL.test(expr)) continue;
      const before = text.slice(Math.max(0, m.index! - 2), m.index!);
      if (before === "<@" || before === "<#") continue;
      if (before.endsWith("/")) {
        const prefix = text.slice(0, m.index!);
        const segment = prefix.slice(prefix.lastIndexOf("`") + 1);
        if (segment.includes("://") || !/\s/u.test(segment.replace(/\$\{[^}]*\}/gu, ""))) continue;
      }
      const statics = text.replace(re, "\u0000");
      const first = statics.indexOf("`");
      const last = statics.lastIndexOf("`");
      const inside = first !== -1 && last > first ? statics.slice(first + 1, last) : statics.trim();
      if (!/[^\s\u0000]\s+[^\s\u0000]|[^\s\u0000]\s+\u0000|\u0000\s+[^\s\u0000]/u.test(inside)) continue;
      hits.push({ file, line: index + 1, text: trimmed.slice(0, 160) });
    }
  });
  return hits;
}

interface BaselineEntry {
  readonly count: number;
  readonly why: string;
}

const MODEL = "a tool result or prompt text the MODEL reads, never posted by the host as is";
const OPERATOR = "an operator surface (control route JSON, CLI, an ops log line built as a string): the exact key is the value an operator acts on";
const CONFIG_PR = "a config-repo pull-request body: the scope key is the config value the diff edits (the requester id is a follow-up — it needs a display-name lookup at codemod time)";
const KEY = "builds a key, a commit message or a frozen arg, not text a person reads (the scan cannot tell a spaced key template from prose)";
const CHAIN = "names the approver chain (`chain:<arm>`), which is not a member id";
const ADMIN_ID = "FOLLOW-UP (OPE-2462): a refusal that shows the person the id or config key an admin must list or raise — the key IS the actionable value today; showing it in words needs a design choice";
const TEAMS = "FOLLOW-UP (OPE-2462): the Teams card's requester is a Bot Framework id, and Teams renders no mention; naming the person needs a display-name lookup at card time";

export const BASELINE: Readonly<Record<string, BaselineEntry>> = {
  "packages/core/agent/access/instructions.ts": { count: 1, why: MODEL },
  "packages/core/agent/access/pane-venue.ts": { count: 1, why: ADMIN_ID },
  "packages/core/agent/access/roles.ts": { count: 2, why: ADMIN_ID },
  "packages/core/agent/tools/request_access.ts": { count: 1, why: ADMIN_ID },
  "packages/core/agent/spend/ingress-gate.ts": { count: 2, why: ADMIN_ID },
  "packages/core/agent/spend/spend.ts": { count: 6, why: ADMIN_ID },
  "packages/core/agent/approvals/a2a-delegate.ts": { count: 1, why: CHAIN },
  "packages/core/agent/approvals/connector-op.ts": { count: 1, why: CHAIN },
  "packages/core/agent/approvals/access-request.ts": { count: 5, why: CONFIG_PR },
  "packages/core/agent/approvals/agent-create.ts": { count: 3, why: CONFIG_PR },
  "packages/core/agent/approvals/mcp-server-propose.ts": { count: 3, why: CONFIG_PR },
  "packages/core/agent/approvals/webhook-declare.ts": { count: 3, why: CONFIG_PR },
  "packages/core/agent/credentials/binding-pr.ts": { count: 1, why: CONFIG_PR },
  "packages/core/agent/approvals/allow-rule-pr.ts": { count: 2, why: CONFIG_PR },
  "packages/core/agent/approvals/email-sender.ts": { count: 3, why: CONFIG_PR },
  "packages/core/agent/channels/domain-question.ts": { count: 1, why: MODEL },
  "packages/core/agent/approvals/card-venue.ts": { count: 1, why: MODEL },
  "packages/core/agent/approvals/flow.ts": { count: 2, why: OPERATOR },
  "packages/core/agent/channels/ambient-skip.ts": { count: 5, why: OPERATOR },
  "packages/core/agent/channels/self-dispatch.ts": { count: 1, why: OPERATOR },
  "packages/core/agent/control/delivery-history.ts": { count: 1, why: OPERATOR },
  "packages/core/agent/control/test-route.ts": { count: 2, why: OPERATOR },
  "packages/core/agent/control/writes.ts": { count: 3, why: OPERATOR },
  "packages/core/agent/hooks/egress.ts": { count: 2, why: OPERATOR },
  "packages/core/agent/hooks/routine-outcome.ts": { count: 1, why: OPERATOR },
  "packages/core/agent/hooks/session-park.ts": { count: 1, why: OPERATOR },
  "packages/core/agent/memory/domain.ts": { count: 2, why: OPERATOR },
  "packages/core/agent/memory/layout.ts": { count: 2, why: MODEL },
  "packages/core/agent/onboarding/onboarding.ts": { count: 1, why: KEY },
  "packages/core/agent/routines/ingress.ts": { count: 1, why: OPERATOR },
  "packages/core/agent/schedules/dispatch.ts": { count: 1, why: OPERATOR },
  "packages/core/agent/schedules/routine-dispatch.ts": { count: 8, why: MODEL },
  "packages/core/agent/spend/reporting.ts": { count: 2, why: KEY },
  "packages/core/agent/status/status.ts": { count: 1, why: MODEL },
  "packages/core/agent/tools/clear_connector_override.ts": { count: 1, why: MODEL },
  "packages/core/agent/tools/clear_spend_limit.ts": { count: 2, why: MODEL },
  "packages/core/agent/tools/delegate_to_agent.ts": { count: 1, why: KEY },
  "packages/core/agent/tools/revoke_connector.ts": { count: 1, why: MODEL },
  "packages/core/agent/tools/set_spend_limit.ts": { count: 7, why: MODEL },
  "packages/core/agent/tools/spend_report.ts": { count: 1, why: MODEL },
  "packages/core/agent/tools/usage_report.ts": { count: 2, why: MODEL },
  "packages/core/agent/webhooks/achievability.ts": { count: 2, why: OPERATOR },
  "packages/core/agent/webhooks/dispatch.ts": { count: 3, why: OPERATOR },
  "packages/providers/discord/agent/channels/discord-dispatch-target.ts": { count: 1, why: MODEL },
  "packages/providers/discord/agent/channels/discord-gateway.ts": { count: 1, why: OPERATOR },
  "packages/providers/discord/agent/channels/discord-backscroll.ts": { count: 1, why: MODEL },
  "packages/providers/discord/agent/channels/discord-post-arm.ts": { count: 1, why: MODEL },
  "packages/providers/slack/agent/channels/slack-context.ts": { count: 2, why: MODEL },
  "packages/providers/slack/agent/channels/slack-read.ts": { count: 1, why: MODEL },
  "packages/providers/slack/agent/channels/slack-wake-backscroll.ts": { count: 2, why: MODEL },
  "packages/providers/teams/agent/channels/teams-message-ops.ts": { count: 1, why: OPERATOR },
  "packages/providers/teams/agent/channels/teams-read.ts": { count: 1, why: MODEL },
  "packages/providers/slack/agent/channels/slack.ts": { count: 1, why: KEY },
  "packages/providers/slack/agent/setup/page.ts": { count: 1, why: "the setup page's config snippet: the principal key IS the value the installing operator pastes into the domain config" },
  "packages/providers/teams/agent/approvals/teams-card.ts": { count: 1, why: TEAMS },
  "packages/providers/teams/agent/channels/teams-declared-target.ts": { count: 1, why: MODEL },
  "packages/providers/teams/agent/channels/teams-front.ts": { count: 1, why: OPERATOR },
};

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "packages"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\0")
    .filter((f) => SCOPE.test(f) && f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .filter((f) => !/\.generated\.ts$/u.test(f) && !/(^|\/)docs\/generated\//u.test(f) && !/(^|\/)docs-generated\.ts$/u.test(f));
}

export function scanRepo(): Map<string, RawIdHit[]> {
  const byFile = new Map<string, RawIdHit[]>();
  for (const file of trackedFiles()) {
    let source: string;
    try {
      source = readFileSync(join(REPO_ROOT, file), "utf8");
    } catch {
      continue;
    }
    const hits = rawIdHits(file, source);
    if (hits.length > 0) byFile.set(file, hits);
  }
  return byFile;
}

export function verdicts(byFile: ReadonlyMap<string, readonly RawIdHit[]>, baseline: Readonly<Record<string, BaselineEntry>> = BASELINE): string[] {
  const problems: string[] = [];
  for (const [file, hits] of byFile) {
    const allowed = baseline[file]?.count ?? 0;
    if (hits.length > allowed) {
      problems.push(
        `${file}: ${hits.length} raw-id interpolation(s) in prose, baseline ${allowed}. Render the person or place through ` +
          `channels/friendly-ids.ts (personWords / placeWords / requesterWords), or use a platform mention:\n` +
          hits.map((h) => `    ${h.line}: ${h.text}`).join("\n"),
      );
    }
  }
  for (const [file, entry] of Object.entries(baseline)) {
    const have = byFile.get(file)?.length ?? 0;
    if (have < entry.count) problems.push(`${file}: baseline ${entry.count} but only ${have} remain — lower the baseline in scripts/friendly-ids-lint.ts to ${have}.`);
  }
  return problems;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("friendly-ids-lint.ts");
if (isMain) {
  const byFile = scanRepo();
  if (process.argv.includes("--counts")) {
    for (const [file, hits] of [...byFile].sort()) console.log(`${hits.length}\t${file}`);
  } else {
    const problems = verdicts(byFile);
    if (problems.length > 0) {
      console.error(`✗ lint:friendly-ids — ${problems.length} problem(s):\n${problems.join("\n")}`);
      process.exit(1);
    }
    console.log(`✓ lint:friendly-ids — ${[...byFile.values()].reduce((n, h) => n + h.length, 0)} baselined raw-id interpolation(s) in ${byFile.size} file(s), none new.`);
  }
}
