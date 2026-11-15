import { QUOTE_MAX, plainQuote } from "./plain-text.js";
import { putDomainSkill } from "../skills/domain-skills.js";
import { armingApproval } from "./arming-context.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";
import { plainValue } from "./plain-text.js";

interface SkillCreateArgs {
  readonly org: string;
  readonly domain: string;
  readonly name: string;
  readonly content: string;
  readonly action: "created" | "updated";
  readonly authoredBy?: string;
  /** @deprecated Since OPE-2717 nothing writes or reads it. A card frozen before the deploy can still carry it; it is ignored. OPE-2721 removes it. */
  readonly tainted?: boolean;
}

const CARD_BODY_MAX = 1200;

const skillCreate: ActionKind<SkillCreateArgs> = {
  kind: "skill.create",
  policy: "member",
  plainSummary(args) {
    return `${args.action === "updated" ? "Change" : "Add"} the skill ${plainValue(args.name)} that the agent follows in ${plainValue(args.domain)}`;
  },
  consequence: (args) => plainQuote(args.content, QUOTE_MAX - 2),
  consequenceQuotes: true,
  summarize(args) {
    const shown = args.content.length > CARD_BODY_MAX ? `${args.content.slice(0, CARD_BODY_MAX)}\n… (${args.content.length - CARD_BODY_MAX} more bytes)` : args.content;
    return [
      `${args.action === "updated" ? "Update" : "Create"} skill \`${args.name}\` in domain \`${args.domain}\` — the agent will LOAD and FOLLOW this by name`,
      "```",
      shown,
      "```",
    ];
  },
  async execute(args, decidedBy) {
    const arming = armingApproval();
    await putDomainSkill(args.org, args.domain, args.name, args.content, args.authoredBy, new Date().toISOString(), {
      armedBy: decidedBy,
      ...(arming ? { approvalId: arming.id } : {}),
    });
    await appendAudit({
      org: args.org,
      platform: "-",
      workspace: "-",
      action: args.action === "updated" ? "skill.update" : "skill.create",
      principalId: decidedBy,
      detail: { domain: args.domain, name: args.name, authoredBy: args.authoredBy ?? null, armedBy: decidedBy },
    });
    emitTelemetry("oe.feature.used", { "oe.feature": "skill_created", "oe.outcome": "ok" });
    return `skill ${args.name} ${args.action} in ${args.domain}; the agent follows it from its next turn`;
  },
};

registerActionKind(skillCreate);
