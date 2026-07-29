import { putDomainSkill } from "../skills/domain-skills.js";
import { armingApproval } from "./arming-context.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";

export interface SkillCreateArgs {
  readonly org: string;
  readonly domain: string;
  readonly name: string;
  readonly content: string;
  readonly action: "created" | "updated";
  readonly authoredBy?: string;
  readonly tainted?: boolean;
}

const CARD_BODY_MAX = 1200;

const skillCreate: ActionKind<SkillCreateArgs> = {
  kind: "skill.create",
  policy: "member",
  summarize(args) {
    const shown = args.content.length > CARD_BODY_MAX ? `${args.content.slice(0, CARD_BODY_MAX)}\n… (${args.content.length - CARD_BODY_MAX} more bytes)` : args.content;
    return [
      `${args.action === "updated" ? "Update" : "Create"} skill \`${args.name}\` in domain \`${args.domain}\` — the agent will LOAD and FOLLOW this by name`,
      ...(args.tainted ? ["⚠ authored in a turn that read external content — read the body carefully before arming"] : []),
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
      detail: { domain: args.domain, name: args.name, authoredBy: args.authoredBy ?? null, armedBy: decidedBy, tainted: Boolean(args.tainted) },
    });
    emitTelemetry("oe.feature.used", { "oe.feature": "skill_created", "oe.outcome": "ok" });
    return `skill "${args.name}" ${args.action} in domain "${args.domain}" — armed from the next turn.`;
  },
};

registerActionKind(skillCreate);
