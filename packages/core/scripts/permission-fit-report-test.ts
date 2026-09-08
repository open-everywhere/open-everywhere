import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-permfit-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

const { registerConfig } = await import("../agent/access/config.js");
const { appendAudit, readAudit } = await import("../agent/audit/audit.js");
const { resolvePartition } = await import("../agent/memory/partition.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

const ROLE = "arn:aws:iam::123456789012:role/oe-ops";
const IDLE_ROLE = "arn:aws:iam::123456789012:role/oe-idle";

const BUNDLES = Object.freeze([
  Object.freeze({
    name: "ops-tools",
    awsRoles: [
      { roleArn: ROLE, allow: ["logs:Describe*", "s3:GetObject"] },
      { roleArn: IDLE_ROLE, allow: ["s3"] },
    ],
    connectors: [
      { name: "notion", credential: "k", contentOrigin: "external" },
      { name: "linear", credential: "k", contentOrigin: "external" },
    ],
  }),
]);
const CONFIG_SNAPSHOT = JSON.stringify(BUNDLES);

const ctx = {
  channel: { kind: "local" },
  session: { id: "sess_permfit", auth: { current: { attributes: {}, principalId: "U_ASKER" } } },
};

const partition = resolvePartition(ctx as never);
const SURFACE_KEY = `${partition.platform}/${partition.workspace}/${partition.surface}`;

registerConfig({
  loadConnectorCredentials: () => [
    { connector: "notion", allows: ["api-key"], credentials: [{ id: "k", type: "api-key", secretRef: "NOTION_K", broker: "env" }] },
    { connector: "linear", allows: ["api-key"], credentials: [{ id: "k", type: "api-key", secretRef: "LINEAR_K", broker: "env" }] },
  ] as never,
  loadBundles: () => BUNDLES as never,
  loadBindings: () => [{ bundle: "ops-tools", scope: { level: "domain", domain: "ops" } }],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [{ name: "ops", channels: [SURFACE_KEY] }],
  loadSilos: () => [],
  domainsForSurface: () => ["ops"],
});

const tool = (await import("../agent/tools/permission_fit_report.js")).default as {
  execute(
    input: { days?: number; direction?: "both" | "widen" | "tighten" },
    ctx: unknown,
  ): Promise<{
    domain: string;
    window: { since: string; until: string; days: number };
    rowsConsidered: number;
    truncated: boolean;
    grantsExamined: number;
    proposals: { id: string; direction: string; subject: string; summary: string; evidence: string[]; diff?: string; remedy?: string }[];
    report: string;
  }>;
};

function ago(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function seed(action: string, detail: Record<string, unknown>, days: number, surface = partition.surface): Promise<void> {
  await appendAudit({
    org: partition.org,
    platform: partition.platform,
    workspace: partition.workspace,
    surface,
    principalId: "slack/U-ALICE",
    action,
    detail,
    ts: ago(days),
  });
}

{
  const res = await tool.execute({}, ctx);
  ok(res.domain === "ops", "scope: the report resolves the caller's channel to its memory domain");
  ok(res.rowsConsidered === 0 && res.proposals.length === 0, "⭐ empty: an empty audit log produces no proposals");
  ok(res.grantsExamined === 4, "empty: both AWS roles and both connectors are still enumerated (2 + 2)");
  ok(res.report.includes("absence of evidence"), "empty: the report says the silence is an absence of evidence");
}

for (let i = 1; i <= 6; i++) {
  await seed("aws.exec", { roleArn: ROLE, command: "logs:describe-log-groups", exitCode: 0, unattended: true, domain: "ops" }, i);
  await seed("connector.op", { connection: "notion", op: "search", tier: "open", opTier: "read" }, i);
}
for (const d of [2, 4, 9]) {
  await seed("aws.refused", { roleArn: ROLE, command: "logs:start-query", allow: ["logs:Describe*", "s3:GetObject"], unattended: true, reason: "allow-list", domain: "ops" }, d);
}
for (const d of [1, 3]) {
  await seed(
    "approval.chain",
    {
      tool: "create_ticket",
      verdict: "deny",
      resolvedBy: "registry",
      registryVerdict: "ask",
      elements: [],
      transforms: [{ name: "unattended", from: "ask", to: "deny", reason: "ask-unattended" }],
      unattended: true,
      domain: "ops",
    },
    d,
  );
}
for (const d of [3, 6]) await seed("connector.refused", { connection: "github", reason: "ungranted" }, d);
for (const d of [2, 5]) {
  await seed("connector.refused", { connection: "notion", op: "notion__create_page", tier: "write", reason: "ask-unattended", grant: "connector.tool:notion__create_page", routine: "oe-routine:rt_nightly:g1" }, d);
}
await seed("connector.refused", { connection: "notion", op: "notion__delete_page", tier: "destructive", reason: "ask-unattended", routine: "oe-routine:rt_nightly:g1" }, 4);
await seed("connector.refused", { connection: "notion", op: "notion__create_page", tier: "write", reason: "ask-unattended-tainted", tainted: true, routine: "oe-routine:rt_nightly:g1" }, 4);
await seed("connector.refused", { connection: "notion", op: "notion__create_page", tier: "write", reason: "ask-unattended", routine: null }, 6);
for (const d of [2, 7]) await seed("connector.refused", { connection: "linear", reason: "dm_only", mode: "channel" }, d);
for (const d of [8, 9]) await seed("connector.refused", { connection: "linear", reason: "ungranted" }, d);

const RT_WEEKLY = "oe-routine:rt_weekly:g2";
for (const d of [9, 8, 7]) {
  await seed("connector.refused", { connection: "linear", op: "linear__create_issue", tier: "write", reason: "ask-unattended", grant: "connector.tool:linear__create_issue", routine: RT_WEEKLY }, d);
}
await seed("routine.permission_granted", { routine: "rt_weekly", grant: "connector.tool:linear__create_issue", declaration: "tool:linear__create_issue", key: RT_WEEKLY }, 6);
for (const d of [5, 4]) {
  await seed("connector.refused", { connection: "linear", op: "linear__update_issue", tier: "write", reason: "ask-unattended", grant: "connector.tool:linear__update_issue", routine: RT_WEEKLY }, d);
}
await seed("connector.unattended_lift", { connection: "linear", op: "linear__update_issue", tier: "write", grant: "connector.tool:linear__update_issue", routine: RT_WEEKLY }, 3);

await seed("aws.exec", { roleArn: IDLE_ROLE, command: "s3:get-object", exitCode: 0, unattended: true, domain: "finance" }, 2);
for (let i = 1; i <= 8; i++) await seed("connector.op", { connection: "linear", op: "list_issues" }, i, "other-channel");

const auditBefore = (await readAudit({})).length;

{
  const res = await tool.execute({ days: 30 }, ctx);
  const ids = res.proposals.map((p) => p.id);

  ok(res.window.days === 30 && !res.truncated, "window: the requested window is what was measured, uncapped");

  const widenAws = res.proposals.find((p) => p.id === `widen:aws:${ROLE}:logs:start-query`);
  ok(widenAws !== undefined && widenAws.direction === "widen", "loop 1: the repeated allow-list refusal produces a widening proposal");
  ok(widenAws!.diff !== undefined && widenAws!.diff.includes('+  "logs:StartQuery",'), "loop 1: …with a mechanical diff against the LOADED bundle's allow-list");
  ok(widenAws!.diff!.includes("ops-tools"), "loop 1: …naming the declaring bundle");

  ok(ids.includes("widen:unattended:create_ticket"), "loop 1: the unattended chain denies produce a proposal too");
  ok(res.proposals.find((p) => p.id === "widen:unattended:create_ticket")!.diff === undefined, "loop 1: …with no fabricated config diff, because that actuator is not a bundle edit");

  const ungranted = res.proposals.find((p) => p.id === "widen:connector:ungranted:github");
  ok(ungranted !== undefined && ungranted.direction === "widen", "⭐ OPE-1291: a repeated `connector.refused`/`ungranted` row surfaces as a widening candidate — the action is in the evidence set AND the reader has a family for it");
  ok(ungranted!.remedy !== undefined && ungranted!.remedy.includes('{ name: "github", credential: "<id>", contentOrigin: "internal" | "external" }'), "OPE-1291: …naming the connector declaration to add, by slug");
  ok(ungranted!.remedy!.includes("agent/access/bundles.ts"), "OPE-1291: …in the config file a reviewer edits");
  ok(ungranted!.diff === undefined, "OPE-1291: …with no fabricated diff — an ungranted connector is in no bundle to render a `before` from, and no row carries a credential id");

  const connUnattended = res.proposals.find((p) => p.id === "widen:connector:unattended:notion");
  ok(connUnattended !== undefined, "⭐ OPE-1291: two unattended WRITE-tier connector refusals produce the empty-room widening proposal on the credential plane too");
  ok(connUnattended!.summary.includes("2 unattended"), "⭐ OPE-1291: …counting the two liftable rows ONLY — the destructive row, the tainted row and the `routine: null` row share the connection, and a standing permission is the actuator for none of them");
  ok(connUnattended!.evidence.some((e) => e.includes("1 further `ask-unattended`/`write` row(s) carried NO routine")), "⭐ OPE-1291: …and the un-routed row is REPORTED rather than dropped — a webhook/job wake refusal is real evidence with a different actuator, so the proposal names it instead of counting it");
  ok(connUnattended!.diff === undefined, "OPE-1291: …with no config diff, because a standing routine permission is a store row, not bundle config");

  ok(!ids.includes("widen:connector:ungranted:linear"), "⭐ OPE-1291: an `ungranted` cluster on a connector the bundle DOES declare proposes nothing — the current declaration wins over the rows, as it does for an aws allow-list refusal");
  ok(!ids.some((id) => id.startsWith("widen:connector:") && id.endsWith(":linear")), "⭐ OPE-1291: and `dm_only` is a context wall a grant cannot open, so those refusals propose NOTHING either");
  ok(connUnattended!.evidence.some((e) => e.includes("ask-unattended ×4, ask-unattended-tainted ×1")), "OPE-1291: …and the WHOLE reason vocabulary rides on the proposal as evidence, so a reader sees all five rows behind a proposal that stands on two");

  ok(
    !ids.includes("widen:connector:unattended:linear"),
    "🔴 OPE-1349: five answered empty-room refusals on `linear` raise NO 'arm this grant' proposal — both arrival actions (`routine.permission_granted` and `connector.unattended_lift`) are in EVIDENCE_ACTIONS, and dropping either one would put its group back over the floor and re-raise this",
  );
  ok(
    connUnattended!.summary.includes("2 unattended") && !connUnattended!.evidence.some((e) => e.includes("permission ARRIVING")),
    "⭐ OPE-1349 negative control: `notion`'s two empty-room refusals were never answered, so they still propose in the SAME run — the suppression is per (routine grant key × grant kind), not a switch that silenced the family",
  );

  const idle = res.proposals.find((p) => p.id === `tighten:aws:${IDLE_ROLE}`);
  ok(idle !== undefined && idle.direction === "tighten", "⭐ loop 2 + scoping: the role used only by ANOTHER domain reads as unused here");
  const linear = res.proposals.find((p) => p.id === "tighten:connector:ops-tools:linear");
  ok(linear !== undefined, "⭐ loop 2 + scoping: the connector exercised only on another surface reads as unused here");

  ok(
    linear!.subject.includes("REFUSED 9×"),
    "🔴 OPE-1340: `linear` has zero `connector.op` rows because every attempt was REFUSED, so the tightening proposal is ANNOTATED with the count rather than suppressed or left to read as disuse",
  );
  ok(linear!.summary.includes("being reached for, not sitting idle"), "OPE-1340: …and the summary names which of the two opposite states this zero is");
  ok(linear!.evidence.some((e) => /ask-unattended ×5, dm_only ×2, ungranted ×2/.test(e)), "OPE-1340: the whole reason breakdown rides on the tightening proposal — the reviewer decides against the reasons, not the zero");
  ok(linear!.diff !== undefined && linear!.diff.includes('-  "linear",'), "⭐ OPE-1340: the removal diff is unchanged — the ruling annotates the proposal, it never changes the verdict");
  ok(idle!.subject.includes("unused") && !/REFUSED/.test(idle!.subject), "⭐ OPE-1340 negative control: the AWS role that is genuinely idle carries no refusal annotation — the annotation is per-connection evidence, not boilerplate");

  ok(ids.includes(`tighten:aws:${ROLE}`), "loop 2: the busy role's unexercised `s3:GetObject` entry is also proposed for narrowing");

  ok(res.report.includes("The actuator is a reviewed pull request"), "the report states the proposal-only rule in its own bytes");
}

{
  ok(JSON.stringify(BUNDLES) === CONFIG_SNAPSHOT, "⭐ actuates nothing: the loaded bundle config is byte-identical after two full runs");
  const rows = await readAudit({});
  const added = rows.filter((r) => r.ts >= new Date(Date.now() - 60_000).toISOString());
  ok(added.every((r) => r.action === "permission.fit_report"), "⭐ actuates nothing: the ONLY rows the tool added are its own review rows — no access.request, no approval.*, no connector.grant");
  ok(rows.length === auditBefore + 1, "audit: exactly ONE new row since the seed — the run added its own review row and nothing else");
  const own = rows.filter((r) => r.action === "permission.fit_report");
  ok(own.length === 2, "audit: a review that happened IS a row — one per run");
  const detail = own[0]!.detail as Record<string, unknown>;
  ok(detail.domain === "ops" && typeof detail.widen === "number" && typeof detail.tighten === "number", "audit: the row carries counts and the window, never the proposal prose");
  ok(!JSON.stringify(own).includes("logs:StartQuery"), "audit: …and specifically not the diff text — proposals are reproducible from the evidence");
}

{
  const widenOnly = await tool.execute({ days: 30, direction: "widen" }, ctx);
  ok(widenOnly.proposals.every((p) => p.direction === "widen") && widenOnly.proposals.length > 0, "direction: \"widen\" returns only widening proposals");
  const short = await tool.execute({ days: 3, direction: "tighten" }, ctx);
  ok(short.proposals.length === 0, "⭐ floor: a 3-day window proposes no tightening — the floor holds through the wired tool, not only in the pure half");
}

console.log(`✓ permission-fit-report: ${passed} assertions — both loops read the real store, domain scoping holds, the review is audited, and nothing was actuated`);
rmSync(tmp, { recursive: true, force: true });
