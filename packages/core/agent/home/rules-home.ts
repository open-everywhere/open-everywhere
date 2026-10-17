import { createHash } from "node:crypto";

import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { registerHomeAction, registerHomeSection, type HomeBlock, type HomeItemAction, type HomeViewer } from "./home-view.js";

export const RULES_HOME_ACTIONS = { remove: "rules.remove" } as const;

const ITEM_ACTIONS: readonly HomeItemAction[] = [
  { id: RULES_HOME_ACTIONS.remove, label: "Remove", kind: "confirm", confirm: { title: "Remove this rule?", yes: "Remove it", note: "I remove this rule at once. The next act of this kind asks you again." } },
];

export function ruleHomeRef(ruleId: string): string {
  return createHash("sha256").update(ruleId).digest("hex");
}

function dmRoomOf(viewer: HomeViewer): string | undefined {
  return viewer.personal?.surfaceKey;
}

async function rulesBlocks(viewer: HomeViewer): Promise<readonly HomeBlock[]> {
  const blocks: HomeBlock[] = [
    { kind: "divider" },
    { kind: "heading", text: "Your rules" },
    {
      kind: "note",
      text:
        'These are the things you told me to allow without asking you, with "Approve, and allow things like this" on an approval card in our DM. ' +
        "A rule covers only what you ask me for in our DM. I still check each act against it, and some acts always need your click. Remove takes a rule away at once.",
    },
  ];
  const room = dmRoomOf(viewer);
  if (room === undefined) {
    blocks.push({ kind: "note", text: "I could not open our direct messages just now, so I cannot list your rules. It is not empty — it is unavailable. Try again." });
    return blocks;
  }
  const rules = await getOperationalStore().listDmRules(viewer.org, room);
  if (rules.length === 0) {
    blocks.push({ kind: "text", text: "You have no rules. Every act that needs your approval asks you first." });
    return blocks;
  }
  for (const r of rules) blocks.push({ kind: "item", text: r.rule, ref: ruleHomeRef(r.ruleId), actions: ITEM_ACTIONS });
  return blocks;
}

registerHomeSection({ id: "rules.dm", order: 20, build: rulesBlocks });

registerHomeAction(RULES_HOME_ACTIONS.remove, async (viewer, ref) => {
  const room = dmRoomOf(viewer);
  if (room === undefined || ref === undefined) return { notice: "I could not find that rule. Open the page again." };
  const store = getOperationalStore();
  const rule = (await store.listDmRules(viewer.org, room)).find((r) => ruleHomeRef(r.ruleId) === ref);
  if (rule === undefined || !(await store.removeDmRule(viewer.org, room, rule.ruleId))) return { notice: "That rule is not on your list any more, so there was nothing to remove." };
  await appendAudit({
    org: viewer.org,
    platform: viewer.platform,
    workspace: viewer.workspace,
    surface: viewer.personal?.surface ?? "home",
    principalId: viewer.principalId,
    action: "approval.rule.removed",
    detail: { ruleId: rule.ruleId, via: `${viewer.platform}-app-home` },
  }).catch(() => undefined);
  return { notice: "Removed. From now on I ask you again before that kind of act." };
});
