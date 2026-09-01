import {
  MIN_TIGHTEN_OBSERVATIONS,
  MIN_TIGHTEN_WINDOW_DAYS,
  MIN_WIDEN_REFUSALS,
  entryCoversCommand,
  iamEntryForCommandLabel,
  makeWindow,
  permissionEvidence,
  refusalEvidence,
  type DeclaredGrants,
  type EvidenceRow,
} from "../agent/access/permission-evidence.js";
import { proposePermissionChanges, renderPermissionProposals } from "../agent/access/permission-proposal.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const NOW = new Date("2026-08-07T12:00:00.000Z");
const W30 = makeWindow(30, NOW);
const W3 = makeWindow(3, NOW);

function ago(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

const ROLE = "arn:aws:iam::123456789012:role/oe-ops";

function awsRefused(days: number, command: string, allow: readonly string[], unattended = true, reason = "allow-list"): EvidenceRow {
  return {
    ts: ago(days),
    action: "aws.refused",
    detail: { roleArn: ROLE, command, allow, unattended, reason, domain: "ops", principalId: "slack/U-ALICE" },
  };
}

function awsExec(days: number, command: string): EvidenceRow {
  return { ts: ago(days), action: "aws.exec", detail: { roleArn: ROLE, command, exitCode: 0, unattended: true, domain: "ops", principalId: "slack/U-ALICE" } };
}

function chainDeny(days: number, tool: string, reason: string, unattended = true): EvidenceRow {
  return {
    ts: ago(days),
    action: "approval.chain",
    detail: {
      tool,
      verdict: "deny",
      resolvedBy: "registry",
      registryVerdict: "ask",
      elements: [],
      transforms: [{ name: reason === "ask-unattended" ? "unattended" : "taint:refuse", from: "ask", to: "deny", reason }],
      unattended,
      domain: "ops",
      principalId: "slack/U-ALICE",
    },
  };
}

function egressDenied(days: number, host: string, count: number, fingerprint = "c".repeat(64)): EvidenceRow {
  return {
    ts: ago(days),
    action: "egress.denied",
    detail: { host, count, policyFingerprint: fingerprint, windowMs: 60_000, domain: "ops", principalId: "slack/U-ALICE" },
  };
}

function connectorOp(days: number, connection: string, op: string): EvidenceRow {
  return { ts: ago(days), action: "connector.op", detail: { connection, op, tier: "open", opTier: "read", principalId: "slack/U-ALICE" } };
}

const GRANTS: DeclaredGrants[] = [
  { bundle: "ops-tools", awsRoles: [{ roleArn: ROLE, allow: ["logs:Describe*", "s3:GetObject", "ec2"] }], connectors: ["notion", "linear"] },
];

{
  ok(W30.since === "2026-07-08T12:00:00.000Z" && W30.until === NOW.toISOString() && W30.days === 30, "window: 30d window is closed at both ends");

  const rows = [awsRefused(1, "logs:start-query", ["logs:Describe*"]), awsRefused(31, "logs:start-query", ["logs:Describe*"])];
  const ev = refusalEvidence(rows, W30);
  ok(ev.length === 1 && ev[0]!.kind === "aws-allow-list" && ev[0]!.refusals === 1, "window: a row one day outside the window is excluded, not clamped in");

  ok(entryCoversCommand("logs:Describe*", "logs:describe-log-groups"), "coverage: a glob entry covers the CLI spelling it translates to (asked of the live screen)");
  ok(!entryCoversCommand("logs:Describe*", "logs:start-query"), "coverage: a glob entry does not cover an operation outside it");
  ok(entryCoversCommand("ec2", "ec2:describe-instances"), "coverage: a bare service entry covers any operation of that service");
  ok(iamEntryForCommandLabel("logs:start-query") === "logs:StartQuery", "entry: a CLI command label renders as the IAM-native allow entry");
}

{
  const ev = permissionEvidence([], GRANTS, W30);
  ok(ev.rowsConsidered === 0 && ev.refusals.length === 0, "empty: no rows ⇒ no refusal evidence");
  ok(ev.usage.length === 3, "empty: every declared grant is still ENUMERATED (1 role + 2 connectors) — a zero is data");
  ok(ev.usage.every((u) => u.uses === 0), "empty: every grant reads zero uses");
  const proposals = proposePermissionChanges(ev);
  ok(proposals.length === 0, "⭐ empty: an empty window proposes NOTHING — a grant unused over a silent window is not evidence of disuse");
  const report = renderPermissionProposals(ev, proposals);
  ok(report.includes("absence of evidence"), "empty: the report says so in words rather than reading as a clean bill of health");
}

{
  const rows: EvidenceRow[] = [];
  for (let i = 1; i <= 6; i++) rows.push(awsExec(i, "logs:describe-log-groups"));
  for (let i = 1; i <= 6; i++) rows.push(awsExec(i, "s3:get-object"));
  for (let i = 1; i <= 6; i++) rows.push(awsExec(i, "ec2:describe-instances"));
  for (let i = 1; i <= 6; i++) rows.push(connectorOp(i, "notion", "search"));
  for (let i = 1; i <= 6; i++) rows.push(connectorOp(i, "linear", "list_issues"));
  const ev = permissionEvidence(rows, GRANTS, W30);
  ok(ev.activity.awsExec === 18 && ev.activity.connectorOps === 12, "healthy: activity denominators counted per family");
  const proposals = proposePermissionChanges(ev);
  ok(proposals.length === 0, "⭐ healthy: every allow entry exercised, every connector used, no refusals ⇒ NO proposal in either direction");
}

{
  const rows = [
    awsRefused(2, "logs:start-query", ["logs:Describe*", "s3:GetObject", "ec2"]),
    awsRefused(4, "logs:start-query", ["logs:Describe*", "s3:GetObject", "ec2"]),
    awsRefused(9, "logs:start-query", ["logs:Describe*", "s3:GetObject", "ec2"]),
    awsExec(1, "logs:describe-log-groups"),
  ];
  const ev = permissionEvidence(rows, GRANTS, W30);
  const refusal = ev.refusals.find((r) => r.kind === "aws-allow-list");
  ok(refusal !== undefined && refusal.kind === "aws-allow-list" && refusal.refusals === 3 && refusal.unattendedRefusals === 3, "widen: three refusals of one command cluster into one row with the count");

  const proposals = proposePermissionChanges(ev, "widen");
  ok(proposals.length === 1 && proposals[0]!.direction === "widen", "widen: exactly one widening proposal");
  const p = proposals[0]!;
  ok(p.summary.includes("3×") && p.summary.includes("logs:start-query"), "widen: the summary cites the exact refused command and its count");
  ok(p.diff !== undefined, "widen: an allow-list widening carries a mechanical config diff");
  ok(p.diff!.before.join(",") === "logs:Describe*,s3:GetObject,ec2", "widen: `before` is the CURRENT declared allow-list, not the one the row recorded");
  ok(p.diff!.after.includes("logs:StartQuery") && p.diff!.after.length === 4, "widen: `after` appends the IAM-native entry and keeps the operator's ordering");
  ok(p.diff!.text.includes('+  "logs:StartQuery",'), "widen: the rendered diff is applicable by hand");
  ok(p.diff!.bundles.join(",") === "ops-tools", "widen: the diff names the bundle that declares the grant");
  ok(p.id === `widen:aws:${ROLE}:logs:start-query`, "widen: the proposal id is stable and deterministic");
}

{
  const widened: DeclaredGrants[] = [{ bundle: "ops-tools", awsRoles: [{ roleArn: ROLE, allow: ["logs"] }], connectors: [] }];
  const rows = [awsRefused(2, "logs:start-query", ["logs:Describe*"]), awsRefused(3, "logs:start-query", ["logs:Describe*"])];
  const ev = permissionEvidence(rows, widened, W30);
  ok(proposePermissionChanges(ev, "widen").length === 0, "widen: a refusal the CURRENT grant already covers is not re-proposed");

  const one = permissionEvidence([awsRefused(2, "logs:start-query", ["logs:Describe*"])], GRANTS, W30);
  ok(one.refusals.length === 1, "widen: a single refusal is still recorded as evidence");
  ok(proposePermissionChanges(one, "widen").length === 0, `widen: …but one refusal is under the MIN_WIDEN_REFUSALS=${MIN_WIDEN_REFUSALS} floor, so it is not dressed up as a proposal`);
}

{
  const rows = [chainDeny(1, "create_ticket", "ask-unattended"), chainDeny(2, "create_ticket", "ask-unattended"), chainDeny(3, "create_ticket", "ask-unattended")];
  const ev = permissionEvidence(rows, GRANTS, W30);
  const deny = ev.refusals.find((r) => r.kind === "chain-deny");
  ok(deny !== undefined && deny.kind === "chain-deny" && deny.denies === 3 && deny.unattendedDenies === 3, "widen: chain denies cluster by tool with the unattended count");
  const proposals = proposePermissionChanges(ev, "widen");
  ok(proposals.length === 1 && proposals[0]!.summary.includes("3 unattended run(s)"), "widen: an ask-unattended cluster proposes, citing the count");
  ok(proposals[0]!.diff === undefined && proposals[0]!.remedy !== undefined, "⭐ widen: NO fabricated config diff — the actuator for a standing routine permission is not a bundle edit, and the remedy says so");

  for (const reason of ["taint-refused", "mode-deny-all"]) {
    const fenced = permissionEvidence([chainDeny(1, "open_pull_request", reason), chainDeny(2, "open_pull_request", reason), chainDeny(3, "open_pull_request", reason)], GRANTS, W30);
    ok(fenced.refusals.length === 1, `fence: a ${reason} deny is still REPORTED as evidence`);
    ok(proposePermissionChanges(fenced, "widen").length === 0, `⭐ fence: …and is NEVER proposed away — ${reason} is a control working, not a misconfiguration`);
  }

  for (const code of ["credential-read", "argv-option", "mode"]) {
    const fenced = permissionEvidence(
      [awsRefused(1, "configure:list", ["*"], true, code), awsRefused(2, "configure:list", ["*"], true, code), awsRefused(3, "configure:list", ["*"], true, code)],
      GRANTS,
      W30,
    );
    ok(fenced.refusals.length === 0, `⭐ fence: an aws \`${code}\` refusal is not collected as WIDTH evidence at all`);
  }
}

{
  const rows: EvidenceRow[] = [];
  for (let i = 1; i <= 6; i++) rows.push(awsExec(i, "logs:describe-log-groups"));
  const ev = permissionEvidence(rows, GRANTS, W30);
  const usage = ev.usage.find((u) => u.kind === "aws-role");
  ok(usage !== undefined && usage.kind === "aws-role" && usage.covering.join(",") === "logs:Describe*", "tighten: exactly the entry that carried the traffic is `covering`");
  ok(usage !== undefined && usage.kind === "aws-role" && usage.unexercised.join(",") === "s3:GetObject,ec2", "tighten: the entries that covered nothing are `unexercised`");
  const proposals = proposePermissionChanges(ev, "tighten");
  const aws = proposals.find((p) => p.id.startsWith("tighten:aws"));
  ok(aws !== undefined && aws.diff!.after.join(",") === "logs:Describe*", "tighten: the diff narrows the allow-list to the covering entries");
  ok(aws!.diff!.text.includes('-  "s3:GetObject",') && aws!.diff!.text.includes('-  "ec2",'), "tighten: the rendered diff shows both removals");
  ok(!proposals.some((p) => p.id.startsWith("tighten:connector")), "⭐ tighten: unused connectors propose nothing while the connector family has no activity to compare against");

  const starGrant: DeclaredGrants[] = [{ bundle: "ops-tools", awsRoles: [{ roleArn: ROLE, allow: ["*"] }], connectors: [] }];
  const star = proposePermissionChanges(permissionEvidence(rows, starGrant, W30), "tighten");
  ok(star.length === 1 && star[0]!.diff!.after.join(",") === "logs", "tighten: `[\"*\"]` exercised only on logs narrows to the observed SERVICES");
  ok(star[0]!.summary.includes("unrestricted"), "tighten: the summary names the width being given up");

  const twoRoles: DeclaredGrants[] = [
    { bundle: "ops-tools", awsRoles: [{ roleArn: ROLE, allow: ["logs"] }, { roleArn: "arn:aws:iam::123456789012:role/oe-idle", allow: ["s3"] }], connectors: [] },
  ];
  const idle = proposePermissionChanges(permissionEvidence(rows, twoRoles, W30), "tighten");
  ok(idle.length === 1 && idle[0]!.id.endsWith("oe-idle"), "tighten: the role nobody assumed — while another was assumed 6× — is the one proposed for removal");
  ok(idle[0]!.diff!.after.length === 0 && idle[0]!.diff!.path.endsWith('"]'), "tighten: an unused grant's diff targets the whole awsRoles entry, not an empty allow-list");
  ok(idle[0]!.remedy!.includes("empty `allow` is a config error"), "tighten: …and says so, because an empty allow-list would be an invalid narrowing");
}

{
  const rows: EvidenceRow[] = [];
  for (let i = 1; i <= 6; i++) rows.push(connectorOp(i, "notion", "search"));
  const proposals = proposePermissionChanges(permissionEvidence(rows, GRANTS, W30), "tighten");
  const conn = proposals.filter((p) => p.id.startsWith("tighten:connector"));
  ok(conn.length === 1 && conn[0]!.id === "tighten:connector:ops-tools:linear", "tighten: the granted connector with zero ops is proposed for removal");
  ok(conn[0]!.diff!.before.join(",") === "notion,linear" && conn[0]!.diff!.after.join(",") === "notion", "tighten: the diff rewrites the bundle's whole `connectors` array");
}

{
  const rows: EvidenceRow[] = [];
  for (let i = 0; i < 6; i++) rows.push(awsExec(1, "logs:describe-log-groups"));
  ok(W3.days < MIN_TIGHTEN_WINDOW_DAYS, "floors: the 3-day window is under the tightening window floor");
  ok(proposePermissionChanges(permissionEvidence(rows, GRANTS, W3), "tighten").length === 0, `⭐ floors: a window shorter than ${MIN_TIGHTEN_WINDOW_DAYS} days proposes no tightening at all`);

  const thin: EvidenceRow[] = [];
  for (let i = 0; i < MIN_TIGHTEN_OBSERVATIONS - 1; i++) thin.push(awsExec(i + 1, "logs:describe-log-groups"));
  ok(proposePermissionChanges(permissionEvidence(thin, GRANTS, W30), "tighten").length === 0, `⭐ floors: under ${MIN_TIGHTEN_OBSERVATIONS} rows of family activity, nothing is proposed for tightening`);
}

{
  const rows: EvidenceRow[] = [chainDeny(1, "create_ticket", "ask-unattended"), chainDeny(2, "create_ticket", "ask-unattended")];
  for (let i = 1; i <= 6; i++) rows.push(awsExec(i, "logs:describe-log-groups"));
  rows.push(awsRefused(1, "logs:start-query", ["logs:Describe*"]), awsRefused(2, "logs:start-query", ["logs:Describe*"]));
  const ev = permissionEvidence(rows, GRANTS, W30);
  const proposals = proposePermissionChanges(ev);
  ok(proposals.length >= 3, "privacy fixture: the fixture actually produces proposals in both directions");
  const blob = JSON.stringify(ev) + JSON.stringify(proposals) + renderPermissionProposals(ev, proposals);
  ok(!blob.includes("U-ALICE") && !blob.includes("principalId"), "⭐ privacy: every seeded row carried a principal and NONE of it reaches the evidence, the proposals or the report");
}

{
  const rows: EvidenceRow[] = [
    egressDenied(1, "registry.example.com", 4),
    egressDenied(2, "registry.example.com", 3),
    egressDenied(3, "pastebin.test", 1),
  ];
  const ev = permissionEvidence(rows, GRANTS, W30);
  ok(ev.activity.egressDenialRows === 3, "egress: the denial ROWS are counted as their own denominator");

  const denials = ev.refusals.filter((r) => r.kind === "egress-denied");
  ok(denials.length === 2, "egress: rows cluster by HOST, not per row");
  const top = denials[0]!;
  ok(top.kind === "egress-denied" && top.host === "registry.example.com", "egress: the busiest denied host leads");
  ok(top.kind === "egress-denied" && top.denials === 7 && top.windows === 2, "egress: counts SUM across rows, and the number of observation windows is kept separately — 7 denials across 2 windows is not the same statement as 7 in one");
  ok(top.kind === "egress-denied" && top.firstSeen === ago(2) && top.lastSeen === ago(1), "egress: first/last seen span the cluster");

  const proposals = proposePermissionChanges(ev, "widen");
  const egressProposal = proposals.find((p) => p.id === "widen:egress:registry.example.com");
  ok(egressProposal !== undefined, "🔴 egress: a repeatedly-denied host becomes a WIDENING proposal — the blind spot OPE-314 closed");
  ok(egressProposal!.diff === undefined, "egress: no mechanical diff — `domains` vs a connection's `allowedWebsites` depends on whether the call needs a credential, which the evidence cannot answer");
  ok(/allowedWebsites/.test(egressProposal!.remedy ?? "") && /`domains`/.test(egressProposal!.remedy ?? ""), "…so the remedy names BOTH config sites and leaves the choice to the reviewer");
  ok(/Vercel tier/.test(egressProposal!.remedy ?? ""), "🔴 egress: the proposal states the TIER LIMIT — on Vercel no row is ever written, so an empty egress section means 'not observed', never 'nothing was blocked'");
  ok(!proposals.some((p) => p.id === "widen:egress:pastebin.test"), `⭐ egress: a single denial is evidence but not yet a proposal (the same ${MIN_WIDEN_REFUSALS}-refusal floor every family uses)`);

  const burst = permissionEvidence([egressDenied(1, "mirror.example.com", 900)], GRANTS, W30);
  const burstProposal = proposePermissionChanges(burst, "widen").find((p) => p.id === "widen:egress:mirror.example.com");
  ok(burstProposal !== undefined && /ONE window/.test(burstProposal.summary), "🔴 egress: 900 denials inside a single window is flagged as a possible crash-loop, not sold as a standing need");

  const across = permissionEvidence(
    [egressDenied(1, "registry.example.com", 2, "a".repeat(64)), egressDenied(5, "registry.example.com", 2, "b".repeat(64))],
    GRANTS,
    W30,
  );
  const acrossProposal = proposePermissionChanges(across, "widen").find((p) => p.id === "widen:egress:registry.example.com");
  ok(acrossProposal !== undefined && acrossProposal.evidence.some((e) => /2 distinct policy generations/.test(e)), "egress: staying unreachable ACROSS a config change is reported as such");

  const blob = JSON.stringify(ev) + JSON.stringify(proposals) + renderPermissionProposals(ev, proposals);
  ok(!blob.includes("U-ALICE") && !blob.includes("principalId"), "🔴 egress: no principal reaches the evidence, the proposals or the report");
  ok(renderPermissionProposals(ev, proposals).includes("egress-denial row(s)"), "egress: the report's denominator line names this family, so a silent plane is legible as a silent plane");
}

{
  const refused = (days: number, detail: Record<string, unknown>): EvidenceRow => ({
    ts: ago(days),
    action: "connector.refused",
    detail: { ...detail, principalId: "slack/U-ALICE" },
  });

  const ungrantedRows = [refused(1, { connection: "github", reason: "ungranted" }), refused(4, { connection: "github", reason: "ungranted" })];
  const ungrantedEv = permissionEvidence(ungrantedRows, GRANTS, W30);
  const cluster = ungrantedEv.refusals.find((r) => r.kind === "connector-refused");
  ok(cluster !== undefined && cluster.kind === "connector-refused" && cluster.connection === "github", "connector: rows cluster by CONNECTION");
  ok(cluster!.kind === "connector-refused" && cluster!.ungranted === 2 && cluster!.refusals === 2, "connector: the `ungranted` rows are counted on their own field, not left in the reason map alone");
  const ungrantedProposal = proposePermissionChanges(ungrantedEv, "widen").find((p) => p.id === "widen:connector:ungranted:github");
  ok(ungrantedProposal !== undefined, "🔴 connector: a repeatedly-ungranted connection becomes a WIDENING proposal — the blind spot OPE-1291 closed");
  ok(ungrantedProposal!.diff === undefined, "connector: no mechanical diff — an ungranted connector is in no bundle to render a `before` from, and no row carries the credential id the declaration needs");
  ok(/name: "github"/.test(ungrantedProposal!.remedy ?? ""), "…so the remedy names the declaration to add, by slug");
  ok(/revoke_connector/.test(ungrantedProposal!.remedy ?? ""), "🔴 connector: …and warns that a break-glass revoke produces this SAME reason code, which no config edit defeats");

  const declaredEv = permissionEvidence([refused(1, { connection: "notion", reason: "ungranted" }), refused(4, { connection: "notion", reason: "ungranted" })], GRANTS, W30);
  ok(
    !proposePermissionChanges(declaredEv, "widen").some((p) => p.id === "widen:connector:ungranted:notion"),
    "⭐ connector: an `ungranted` cluster on a DECLARED connector proposes nothing — the current grant wins over the rows, exactly as it does for an aws allow-list refusal",
  );

  const unattendedRows = [
    refused(1, { connection: "notion", op: "notion__create_page", tier: "write", reason: "ask-unattended", routine: "rt_a" }),
    refused(2, { connection: "notion", op: "notion__create_page", tier: "write", reason: "ask-unattended", routine: "rt_a" }),
    refused(3, { connection: "notion", op: "notion__delete_page", tier: "destructive", reason: "ask-unattended", routine: "rt_a" }),
    refused(4, { connection: "notion", op: "notion__create_page", tier: "write", reason: "ask-unattended-tainted", tainted: true, routine: "rt_a" }),
    refused(5, { connection: "notion", op: "notion__create_page", tier: "write", reason: "ask-unattended", routine: null }),
  ];
  const unattendedEv = permissionEvidence(unattendedRows, GRANTS, W30);
  const unattendedCluster = unattendedEv.refusals.find((r) => r.kind === "connector-refused")!;
  ok(unattendedCluster.kind === "connector-refused" && unattendedCluster.refusals === 5, "connector: all five rows land in one cluster");
  ok(
    unattendedCluster.kind === "connector-refused" && unattendedCluster.liftableUnattended === 2,
    "🔴 connector: only the `ask-unattended` × `write` × HAS-A-ROUTINE rows are liftable — the destructive row, the tainted row and the `routine: null` row are counted but never liftable, because no standing permission is their actuator",
  );
  ok(unattendedCluster.kind === "connector-refused" && unattendedCluster.unroutedUnattended === 1, "connector: …and the un-routed row is kept on its own field rather than dropped");
  const unattendedProposal = proposePermissionChanges(unattendedEv, "widen").find((p) => p.id === "widen:connector:unattended:notion");
  ok(unattendedProposal !== undefined && /2 unattended/.test(unattendedProposal.summary), "🔴 connector: the empty-room refusal proposes on the credential plane too, counting the two liftable rows ONLY");
  ok(unattendedProposal!.diff === undefined && /edit_routine/.test(unattendedProposal!.remedy ?? ""), "connector: …with no bundle diff — a standing routine permission is a store row, not config");
  ok(/destructive/.test(unattendedProposal!.remedy ?? ""), "🔴 connector: …and the remedy states that a destructive op and a tainted turn are lifted by NOTHING, so those rows read as a control working");

  const walls = [
    refused(1, { connection: "notion", reason: "dm_only", mode: "channel" }),
    refused(2, { connection: "notion", reason: "dm_only", mode: "channel" }),
    refused(3, { connection: "notion", reason: "audience_floor" }),
    refused(4, { connection: "notion", reason: "audience_floor" }),
    refused(5, { connection: "notion", reason: "requestor_unentitled" }),
    refused(6, { connection: "notion", reason: "requestor_unentitled" }),
    refused(7, { connection: "notion", reason: "unresolved_surface" }),
    refused(8, { connection: "notion", reason: "unresolved_surface" }),
    refused(9, { connection: "notion", reason: "member_plane_write" }),
    refused(10, { connection: "notion", reason: "member_plane_write" }),
  ];
  const wallsEv = permissionEvidence(walls, GRANTS, W30);
  ok(wallsEv.refusals.filter((r) => r.kind === "connector-refused").length === 1, "walls fixture: the rows are read and clustered — otherwise the assertion below is vacuous");
  ok(
    proposePermissionChanges(wallsEv, "widen").filter((p) => p.id.startsWith("widen:connector:")).length === 0,
    "⭐ connector: ten refusals across five reason codes a grant cannot open — a context wall, both disclosure legs, an unresolvable surface and the member plane — propose NOTHING",
  );

  ok(
    permissionEvidence([refused(1, { reason: "ungranted" }), refused(2, { reason: "ungranted" })], GRANTS, W30).refusals.filter((r) => r.kind === "connector-refused").length === 0,
    "connector: a row with no `connection` is dropped — there is nothing to name in a remedy, and a placeholder bucket would invent one",
  );

  const privacyEv = permissionEvidence([...ungrantedRows, ...unattendedRows], GRANTS, W30);
  const privacyProposals = proposePermissionChanges(privacyEv);
  ok(privacyProposals.length > 0, "connector privacy fixture: the fixture actually produces proposals");
  const connectorBlob = JSON.stringify(privacyEv) + JSON.stringify(privacyProposals) + renderPermissionProposals(privacyEv, privacyProposals);
  ok(!connectorBlob.includes("U-ALICE") && !connectorBlob.includes("principalId"), "⭐ connector privacy: the refusal rows carry a principal COLUMN and a principal-shaped detail, and none of it reaches the evidence, the proposals or the report");
  ok(!connectorBlob.includes("rt_a"), "⭐ connector privacy: the routine GRANT KEY does not reach the output either — only whether one was present is read");
}

{
  const rows: EvidenceRow[] = [];
  for (let i = 1; i <= 6; i++) rows.push(awsExec(i, "logs:describe-log-groups"));
  rows.push(awsRefused(1, "logs:start-query", ["logs:Describe*"]), awsRefused(2, "logs:start-query", ["logs:Describe*"]));
  const once = renderPermissionProposals(permissionEvidence(rows, GRANTS, W30), proposePermissionChanges(permissionEvidence(rows, GRANTS, W30)));
  const twice = renderPermissionProposals(permissionEvidence([...rows].reverse(), GRANTS, W30), proposePermissionChanges(permissionEvidence([...rows].reverse(), GRANTS, W30)));
  ok(once === twice, "determinism: row order does not change a single byte of the report");
  ok(once.includes("The actuator is a reviewed pull request"), "report: the proposal-only rule is stated in the artefact itself, not only in the docs");
}

console.log(`✓ permission-homeostasis: ${passed} assertions — both loops measure from seeded audit rows, propose only where the evidence carries it, and stay silent (in both directions) when it does not`);
