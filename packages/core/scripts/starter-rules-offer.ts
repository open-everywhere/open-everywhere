import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTemplateIgnored, readTemplateIgnore } from "./template-drift.js";

export const STARTER_RULES_PATH = "agent/access/pre-approval-rules.ts";

export function starterRulesOffer(appRoot: string, target: string, templateDir: string | undefined): readonly string[] {
  if (existsSync(join(appRoot, ...STARTER_RULES_PATH.split("/")))) return [];
  if (isTemplateIgnored(readTemplateIgnore(appRoot), STARTER_RULES_PATH)) return [];
  if (templateDir !== undefined && !existsSync(join(templateDir, ...STARTER_RULES_PATH.split("/")))) return [];
  const source =
    templateDir !== undefined
      ? join(templateDir, ...STARTER_RULES_PATH.split("/"))
      : `${STARTER_RULES_PATH} in the @open-everywhere/create@${target} package's template/`;
  return [
    `Starter pre-approval rules (an offer — oe upgrade writes nothing):`,
    `  OFFER     ${STARTER_RULES_PATH} — this app has none, so the approval judge has no rule to cite and every gated act asks a person.`,
    `  To take it: copy ${source} to ${STARTER_RULES_PATH}, then bind it as the template's agent/access/bundles.ts does (the "approval-policy" bundle with \`preApprovalRules: PRE_APPROVAL_RULES\`, bound at org scope).`,
    `  Read each rule before you take it: a rule lets the agent do that act with no card. To keep every act on a card, leave the file out.`,
  ];
}
