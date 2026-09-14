import assert from "node:assert/strict";
import { auditActionFindings } from "./audit-actions-lint.js";
import { scanAuditActions, KNOWN_ROAD_NAMES } from "./audit-action-scan-lib.js";
import {
  CONSEQUENTIAL_AUDIT_ACTIONS,
  DYNAMIC_ACTION_SITES,
  OPERATIONAL_AUDIT_ACTIONS,
  TEMPLATED_AUDIT_ACTIONS,
  consequentialAuditActions,
  declaredAuditActions,
  expandTemplate,
} from "../packages/core/agent/audit/action-registry.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

type Scan = Parameters<typeof auditActionFindings>[0];
const scan = (over: Partial<Scan> = {}): Scan => ({ actions: [], unresolved: [], forwardingHelpers: [], ...over });
const rules = (findings: readonly { readonly rule: string }[]): string[] => [...new Set(findings.map((f) => f.rule))].sort();

{
  const red = auditActionFindings(scan({ actions: ["a.thing"] }), [], []);
  ok(rules(red).includes("undeclared"), "an emitted action the registry does not carry is a finding");
  ok(red[0]?.detail.includes("a.thing") === true, "…and the finding names the action, so the fix needs no hunting");

  const green = auditActionFindings(scan({ actions: ["a.thing"] }), ["a.thing"], []);
  ok(green.length === 0, "🔴 NEGATIVE CONTROL: the same action, declared, produces NO finding");
}

{
  const site = { expression: "row.action", file: "a/b.ts", road: "appendAudit" as const };
  const red = auditActionFindings(scan({ unresolved: [site] }), [], []);
  ok(rules(red).includes("undeclared-dynamic-site"), "a run-time-named site in an undeclared file is a finding");
  ok(red[0]?.detail.includes("row.action") === true, "…and the finding quotes the expression, so the site is findable");

  const green = auditActionFindings(scan({ unresolved: [site] }), ["x.y"], [{ file: "a/b.ts", emits: ["x.y"] }]);
  ok(green.length === 0, "🔴 NEGATIVE CONTROL: the same site, declared with what it emits, produces NO finding");
}

{
  const red = auditActionFindings(scan({ forwardingHelpers: [{ name: "auditSomethingNew", file: "a/b.ts" }] }), [], []);
  ok(rules(red).includes("unknown-road"), "a helper that forwards an action under an unread name is a finding");

  const known = KNOWN_ROAD_NAMES[0] ?? "appendAudit";
  const green = auditActionFindings(scan({ forwardingHelpers: [{ name: known, file: "a/b.ts" }] }), [], []);
  ok(green.length === 0, `🔴 NEGATIVE CONTROL: a helper the scanner already reads (${known}) produces NO finding`);
}

{
  const red = auditActionFindings(scan(), [], [{ file: "a/b.ts", emits: ["ghost.row"] }]);
  ok(rules(red).includes("dangling-declaration"), "a site declaring a name no table carries is a finding");

  const empty = auditActionFindings(scan(), [], [{ file: "a/b.ts", emits: [] }]);
  ok(rules(empty).includes("dangling-declaration"), "an EMPTY emits list is a finding — a site must say what it writes");
  ok(empty.length === 1, "…and exactly one, rather than a finding per absent name");

  const green = auditActionFindings(scan(), ["ghost.row"], [{ file: "a/b.ts", emits: ["ghost.row"] }]);
  ok(green.length === 0, "🔴 NEGATIVE CONTROL: the declared name, present in a table, produces NO finding");
}

{
  const off = auditActionFindings(scan({ actions: ["live.row"] }), ["live.row", "dead.row"], []);
  ok(off.length === 0, "a declared-but-unemitted name is SILENT by default — a deletion in progress must not red the tree");

  const on = auditActionFindings(scan({ actions: ["live.row"] }), ["live.row", "dead.row"], [], { strict: true });
  ok(rules(on) .includes("stale-declaration"), "…and IS a finding under --strict");
  ok(on.length === 1 && on[0]?.detail.includes("dead.row") === true, "…naming only the dead one, never the live one");

  const viaSite = auditActionFindings(scan(), ["only.dynamic"], [{ file: "a/b.ts", emits: ["only.dynamic"] }], { strict: true });
  ok(viaSite.length === 0, "🔴 a name reached only through a declared dynamic site is not stale");
}

{
  const consequential = CONSEQUENTIAL_AUDIT_ACTIONS.map((d) => d.action);
  ok(new Set(consequential).size === consequential.length, "no consequential action is declared twice");
  ok(new Set(OPERATIONAL_AUDIT_ACTIONS).size === OPERATIONAL_AUDIT_ACTIONS.length, "no operational action is declared twice");
  const overlap = consequential.filter((a) => OPERATIONAL_AUDIT_ACTIONS.includes(a));
  ok(overlap.length === 0, `no action is BOTH consequential and operational (got: ${overlap.join(", ")})`);

  for (const d of CONSEQUENTIAL_AUDIT_ACTIONS) {
    ok(d.proves.trim().length > 0, `${d.action} says what a reader learns from it`);
  }
  for (const d of CONSEQUENTIAL_AUDIT_ACTIONS) {
    if (d.notExercised === undefined) continue;
    ok(d.notExercised.trim().length > 20, `${d.action}'s notExercised reason states what is missing (got: "${d.notExercised}")`);
  }

  ok(expandTemplate({ template: "<platform>.x", platforms: ["a", "b"], fields: [], proves: "p", consequential: false }).join(",") === "a.x,b.x",
    "expandTemplate substitutes the platform into each name");
  for (const t of TEMPLATED_AUDIT_ACTIONS) {
    ok(t.template.includes("<platform>"), `${t.template} carries the <platform> hole it is expanded over`);
    ok(t.platforms.length > 0, `${t.template} names at least one platform`);
  }

  const declared = new Set(declaredAuditActions());
  for (const t of TEMPLATED_AUDIT_ACTIONS) {
    for (const name of expandTemplate(t)) ok(declared.has(name), `${name} (from ${t.template}) is in the declared set`);
  }
  ok(consequentialAuditActions().length >= CONSEQUENTIAL_AUDIT_ACTIONS.length, "the census view includes every plain consequential row");
  ok(consequentialAuditActions().some((d) => d.action.endsWith(".post_file.attach")),
    "…and the consequential TEMPLATED rows too, expanded — a family the census would otherwise never assert");
}

{
  const real = scanAuditActions(process.cwd());
  ok(real.actions.length > 100, `the scanner resolves a plausible number of actions (got ${real.actions.length})`);
  ok(real.filesScanned > 50, `…across a plausible number of files (got ${real.filesScanned})`);
  ok(real.actions.includes("reply.post"), "it finds reply.post — the row every surface writes at the post choke point");
  ok(real.actions.includes("docs.read"), "it finds docs.read — reached ONLY through the auditToolAction road");
  ok(real.actions.includes("slack.external_policy_suppressed"), "it finds slack.external_policy_suppressed — reached ONLY through appendRouteAudit");
  ok(real.actions.includes("wake.turn_start"), "it resolves a name spelled as a module constant, not a literal");
  ok(real.actions.includes("identity.link.confirmed"), "it finds a row written through the auditLink forwarding helper");

  const undeclaredNow = auditActionFindings(real, declaredAuditActions(), DYNAMIC_ACTION_SITES);
  ok(undeclaredNow.length === 0, `this tree satisfies the contract (got: ${undeclaredNow.map((f) => f.detail).join(" | ")})`);

  const minusOne = declaredAuditActions().filter((a) => a !== "reply.post");
  const red = auditActionFindings(real, minusOne, DYNAMIC_ACTION_SITES);
  ok(red.some((f) => f.rule === "undeclared" && f.detail.includes("reply.post")),
    "removing reply.post from the registry reds the real scan — the totality check is load-bearing");
}

console.log(`✓ audit-actions lint: ${n} assertions passed`);
