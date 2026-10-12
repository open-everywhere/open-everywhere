import { deleteDomainSkill } from "../skills/domain-skills.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";
import { plainValue } from "./plain-text.js";

interface SkillDeleteArgs {
  readonly org: string;
  readonly domain: string;
  readonly name: string;
  readonly requestedBy?: string;
}

const skillDelete: ActionKind<SkillDeleteArgs> = {
  kind: "skill.delete",
  policy: "member",
  plainSummary(args) {
    return `Delete the skill ${plainValue(args.name)} from ${plainValue(args.domain)}, so the agent stops following it`;
  },
  summarize(args) {
    return [
      `Delete skill \`${args.name}\` in domain \`${args.domain}\` — the agent will no longer load or follow it`,
      "(reversible: it can be re-created with create_skill)",
    ];
  },
  async execute(args, decidedBy) {
    const deleted = await deleteDomainSkill(args.org, args.domain, args.name);
    await appendAudit({
      org: args.org,
      platform: "-",
      workspace: "-",
      action: "skill.delete",
      principalId: decidedBy,
      detail: { domain: args.domain, name: args.name, deleted, requestedBy: args.requestedBy ?? null, confirmedBy: decidedBy },
    });
    const outcomeTag = deleted ? "ok" : "noop";
    emitTelemetry("oe.feature.used", { "oe.feature": "skill_deleted", "oe.outcome": outcomeTag });
    return deleted
      ? `skill ${args.name} deleted from ${args.domain}`
      : `skill ${args.name} was already gone from ${args.domain}, so nothing changed`;
  },
};

registerActionKind(skillDelete);
