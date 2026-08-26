import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_KIND_FAMILIES,
  ADMIN_RULE_ANCHOR,
  APPROVER_POLICY_BEGIN,
  APPROVER_POLICY_END,
  MEMBER_RULE_ANCHOR,
  checkApproverPolicyProse,
  checkApproverPolicyRule,
  isAdminFamily,
  renderApproverPolicyTable,
  sortApproverPolicyRows,
  spliceApproverPolicyTable,
  type ApproverPolicyRow,
} from "../agent/docs/approver-policy.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const CLEAN: ApproverPolicyRow[] = [
  { kind: "connector.revoke", policy: "admin", proposedBy: "revoke_connector" },
  { kind: "memory.purge", policy: "member", proposedBy: "purge_memory" },
  { kind: "session.checkpoint", policy: "member" },
  { kind: "spend.set", policy: "admin", proposedBy: "set_spend_limit" },
];

ok(checkApproverPolicyRule(CLEAN).length === 0, "a clean plane reports no problems");

const empty = checkApproverPolicyRule([]);
ok(empty.length === 1, "an EMPTY row list is refused rather than passing every rule by containing nothing");
ok(empty[0]!.includes("empty plane"), "the empty refusal says why");

ok(
  checkApproverPolicyRule([{ kind: "memory.purge", policy: "member" }]).some((p) => p.includes('no kind registers ApproverPolicy "admin"')),
  "a plane with no admin kind fails",
);
ok(
  checkApproverPolicyRule([{ kind: "spend.set", policy: "admin" }]).some((p) => p.includes('no kind registers ApproverPolicy "member"')),
  "a plane with no member kind fails",
);

const strayAdmin = checkApproverPolicyRule(
  sortApproverPolicyRows([...CLEAN.filter((r) => r.kind !== "memory.purge"), { kind: "memory.purge", policy: "admin" }]),
);
ok(strayAdmin.length === 1, "exactly one problem is reported for one stray admin kind");
ok(strayAdmin[0]!.includes("memory.purge") && strayAdmin[0]!.includes("outside the admin family"), "the stray-admin problem names the kind and the rule it breaks");
ok(checkApproverPolicyRule(CLEAN).length === 0, "…and the same plane with that kind at member is clean");

ok(
  checkApproverPolicyRule(sortApproverPolicyRows([...CLEAN.filter((r) => r.kind !== "spend.set"), { kind: "spend.set", policy: "member" }])).some(
    (p) => p.includes("spend.set") && p.includes("needs an admin"),
  ),
  "a spend kind at member policy fails the rule",
);

for (const family of ADMIN_KIND_FAMILIES) {
  ok(isAdminFamily(`${family.prefix}something`), `"${family.prefix}something" is in the admin family`);
  ok(
    checkApproverPolicyRule(sortApproverPolicyRows([...CLEAN, { kind: `${family.prefix}something`, policy: "member" }])).some((p) => p.includes(`${family.prefix}something`)),
    `a member-policy "${family.prefix}something" fails the rule`,
  );
}
ok(!isAdminFamily("memory.purge"), "an ordinary kind is not in the admin family");
ok(!isAdminFamily("spending.set"), "the family is matched by PREFIX, not by substring");

const SIBLINGS: ApproverPolicyRow[] = [
  { kind: "ticket.set.owner", policy: "member" },
  { kind: "ticket.set_state", policy: "member" },
  { kind: "spend.set", policy: "admin" },
  { kind: "connector.revoke", policy: "admin" },
];
const sortedSiblings = sortApproverPolicyRows(SIBLINGS);
ok(checkApproverPolicyRule(sortedSiblings).length === 0, "the sorter's own output passes the order check on a `.`-vs-`_` sibling pair");
ok(
  sortedSiblings.map((r) => r.kind).join(",") === "connector.revoke,spend.set,ticket.set.owner,ticket.set_state",
  "…and it is code-unit order, which is what registeredActionKinds() returns",
);
ok(
  checkApproverPolicyRule([sortedSiblings[1]!, sortedSiblings[0]!, sortedSiblings[2]!, sortedSiblings[3]!]).some((p) => p.includes("out of order")),
  "an unsorted row list fails",
);
ok(checkApproverPolicyRule([...CLEAN, { kind: "spend.set", policy: "admin" }]).some((p) => p.includes("appears twice")), "a duplicated kind fails");

const table = renderApproverPolicyTable(CLEAN);
ok(table.startsWith(APPROVER_POLICY_BEGIN) && table.endsWith(APPROVER_POLICY_END), "the table carries its own markers");
ok(table.includes("| `memory.purge` | `purge_memory` | member |"), "a member row renders its kind, its propose tool and its policy");
ok(table.includes("| `spend.set` | `set_spend_limit` | admin |"), "an admin row renders at the admin policy");
ok(table.includes("| `session.checkpoint` | — *(no propose tool)* | member |"), "a kind no tool proposes says so rather than rendering an empty cell");
ok(renderApproverPolicyTable(CLEAN) === table, "rendering is deterministic");
ok(!renderApproverPolicyTable(CLEAN.slice(0, 3)).includes("spend.set"), "a row that is not in the list is not in the table");

const doc = `# Title\n\nbefore\n\n${APPROVER_POLICY_BEGIN}\nstale\n${APPROVER_POLICY_END}\n\nafter\n`;
const spliced = spliceApproverPolicyTable(doc, table);
ok("updated" in spliced, "a document with markers splices");
if (!("updated" in spliced)) process.exit(1);
ok(spliced.updated.includes("before") && spliced.updated.includes("after"), "the surrounding prose survives");
ok(!spliced.updated.includes("stale"), "the previous block is REPLACED, not appended to");
ok(spliced.updated.split(APPROVER_POLICY_BEGIN).length === 2, "exactly one block remains");
const again = spliceApproverPolicyTable(spliced.updated, table);
ok("updated" in again && again.updated === spliced.updated, "a second splice over the result is a no-op (idempotent)");

ok("problem" in spliceApproverPolicyTable("# Title\n\nno block here\n", table), "a document with no markers is refused");
ok("problem" in spliceApproverPolicyTable(`${APPROVER_POLICY_END}\n${APPROVER_POLICY_BEGIN}\n`, table), "markers in the wrong order are refused");

const families = ADMIN_KIND_FAMILIES.map((f) => f.noun).join(" and ");
const prose = (adminBullet: string, memberBullet = MEMBER_RULE_ANCHOR): string =>
  `# Doc\n\n- ${adminBullet} covering ${families} writes.\n- ${memberBullet} Any member of the channel.\n`;

ok(checkApproverPolicyProse(prose(ADMIN_RULE_ANCHOR)).length === 0, "a manual stating the rule, naming every family, is clean");

const reworded = checkApproverPolicyProse(prose("**Admin kinds are the spend caps**"));
ok(reworded.some((p) => p.includes("gone from the manual")), "a REWORDED admin anchor fails rather than silently checking nothing");

const missingMember = checkApproverPolicyProse(prose(ADMIN_RULE_ANCHOR, "**Members can click some of them.**"));
ok(missingMember.some((p) => p.includes("member half")), "a reworded member anchor fails too");

const twice = checkApproverPolicyProse(prose(ADMIN_RULE_ANCHOR) + prose(ADMIN_RULE_ANCHOR));
ok(twice.some((p) => p.includes("appears 2 times")), "a rule stated twice fails — a later fix could land on one copy");

for (const family of ADMIN_KIND_FAMILIES) {
  const narrowed = ADMIN_KIND_FAMILIES.filter((f) => f !== family)
    .map((f) => f.noun)
    .join(" and ");
  const dropped = checkApproverPolicyProse(`# Doc\n\n- ${ADMIN_RULE_ANCHOR} covering ${narrowed} writes.\n- ${MEMBER_RULE_ANCHOR} Any member.\n`);
  ok(
    dropped.some((p) => p.includes(`no longer says "${family.noun}"`)),
    `an admin bullet that drops "${family.noun}" fails, even with both anchors intact`,
  );
}

ok(
  checkApproverPolicyProse(`# Doc\n\n- ${MEMBER_RULE_ANCHOR} Any member.\n- ${ADMIN_RULE_ANCHOR} ${families}.\n`).some((p) => p.includes("BEFORE the admin half")),
  "the two halves in the wrong order fail — the family scan reads the text between them",
);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manual = readFileSync(join(root, "docs", "security", "control-plane.md"), "utf8");
ok(manual.includes(APPROVER_POLICY_BEGIN) && manual.includes(APPROVER_POLICY_END), "docs/security/control-plane.md carries the generated-section markers");
ok(manual.indexOf(APPROVER_POLICY_BEGIN) < manual.indexOf(APPROVER_POLICY_END), "…in that order");
ok(manual.split(APPROVER_POLICY_BEGIN).length === 2, "…exactly once");
ok(checkApproverPolicyProse(manual).length === 0, "…and it states the rule the table is generated under");

console.log(`✓ approver-policy: ${passed} assertions`);
