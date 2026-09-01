import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bundleConnectorNames } from "../access/bundle.js";
import { getConfig } from "../access/config.js";
import { resolveAccessFor } from "../access/request.js";
import { resolveSkillDomainDetailed } from "../skills/domain-skills.js";
import { reportDomainRefusalMessage } from "../spend/reporting.js";
import { resolvePartition } from "../memory/partition.js";
import { domainForChannel } from "../memory/domain.js";
import { readAudit, type AuditEntry } from "../audit/audit.js";
import { auditToolAction } from "../audit/tool-action.js";
import {
  MIN_TIGHTEN_OBSERVATIONS,
  MIN_TIGHTEN_WINDOW_DAYS,
  makeWindow,
  permissionEvidence,
  type DeclaredGrants,
  type EvidenceRow,
} from "../access/permission-evidence.js";
import { proposePermissionChanges, renderPermissionProposals } from "../access/permission-proposal.js";
import type { BindableContext } from "../identity/binding.js";
import { getGitHubApp } from "../scm/provider.js";
import { repoCapabilityRows, renderRepoCapabilityRows, repoOwner } from "../scm/capability-fit.js";

const EVIDENCE_ACTIONS = [
  "aws.exec",
  "aws.refused",
  "connector.op",
  "connector.refused",
  "approval.chain",
  "egress.denied",
] as const;

const ROW_CAP = 4000;

const MAX_INSTALLATION_PROBES = 10;

export default defineTool({
  description:
    "Report whether this domain's PERMISSION GRANTS still fit the work — in both directions, from the audit log. Widening: unattended runs that keep hitting refusals (an AWS allow-list refusal, an approval card nobody could answer, a host the egress firewall keeps blocking, a connector this scope was never granted). Tightening: grants nothing exercised in the window, and allow-lists far wider than what was actually run. Returns evidence counts plus concrete, reviewable config-change proposals. It proposes only: nothing is granted, revoked, gated or delayed by this — every proposal is a pull request a human merges. Use when asked \"do we still need all this access?\", \"why does this routine keep getting refused?\", or on a schedule as a standing permission review. For \"would tool X be allowed here right now?\" use explain_permission instead.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(90).optional().describe(`Window length in days (default 30). Tightening proposals need at least ${MIN_TIGHTEN_WINDOW_DAYS} days; shorter windows report widening evidence only.`),
    direction: z.enum(["both", "widen", "tighten"]).optional().describe("Which loop to report. Default \"both\"."),
  }),
  outputSchema: z.object({
    domain: z.string(),
    window: z.object({ since: z.string(), until: z.string(), days: z.number() }),
    rowsConsidered: z.number(),
    truncated: z.boolean().describe("A per-action row cap was hit — usage is UNDER-counted, so treat any tightening proposal as unproven and re-run over a shorter window."),
    grantsExamined: z.number(),
    proposals: z.array(
      z.object({
        id: z.string(),
        direction: z.enum(["widen", "tighten"]),
        subject: z.string(),
        summary: z.string(),
        evidence: z.array(z.string()),
        diff: z.string().optional().describe("The proposed config change, rendered. Absent when the actuator is not a config-file diff — `remedy` then says what it is."),
        remedy: z.string().optional(),
      }),
    ),
    repoCapabilities: z
      .array(z.object({ repo: z.string(), capability: z.string(), declared: z.boolean(), installationSupports: z.enum(["yes", "no", "unreported"]) }))
      .describe("Per (repo, named capability set): whether this domain's binding already opted in, and whether the App installation can honour it. Proposal input — nothing here grants anything."),
    report: z.string().describe("The whole thing as readable text — post this."),
  }),
  approval: never(),
  async execute(input, ctx) {
    const bindable = ctx as BindableContext;
    const partition = resolvePartition(bindable);
    const resolved = resolveSkillDomainDetailed(bindable);
    if (resolved.domain === null) throw new Error(reportDomainRefusalMessage(resolved.reason));
    const domain = resolved.domain;

    const days = input.days ?? 30;
    const window = makeWindow(days, new Date());

    const access = resolveAccessFor(bindable);
    const effectiveArns = new Set(access.awsRoles.map((r) => r.roleArn));
    const effectiveConnectors = new Set(access.connectors);
    const bundles = getConfig().loadBundles();
    const grants: DeclaredGrants[] = bundles
      .map((b) => ({
        bundle: b.name,
        awsRoles: (b.awsRoles ?? [])
          .filter((r) => effectiveArns.has(r.roleArn))
          .map((r) => ({ roleArn: r.roleArn, allow: r.allow })),
        connectors: bundleConnectorNames(b).filter((c) => effectiveConnectors.has(c)),
      }))
      .filter((g) => g.awsRoles.length > 0 || g.connectors.length > 0);

    const domains = getConfig().loadDomains();
    const inThisDomain = (row: AuditEntry): boolean => {
      const detailDomain = row.detail?.domain;
      if (typeof detailDomain === "string" && detailDomain.length > 0) return detailDomain === domain;
      if (row.surface === undefined) return false;
      return domainForChannel(`${row.platform}/${row.workspace}/${row.surface}`, domains)?.name === domain;
    };

    let truncated = false;
    const rows: EvidenceRow[] = [];
    for (const action of EVIDENCE_ACTIONS) {
      const page = await readAudit({ org: partition.org, action, since: window.since, limit: ROW_CAP });
      if (page.length >= ROW_CAP) truncated = true;
      for (const row of page) if (inThisDomain(row)) rows.push({ ts: row.ts, action: row.action, detail: row.detail });
    }

    const app = getGitHubApp();
    const owners = [...new Set(access.repos.map(repoOwner).filter((o) => o !== ""))].slice(0, MAX_INSTALLATION_PROBES);
    const grantedByOwner: Record<string, Readonly<Record<string, string>> | undefined> = {};
    const installationIdByOwner: Record<string, string | undefined> = {};
    for (const owner of owners) {
      grantedByOwner[owner] = app ? await app.installationPermissions(owner).catch(() => undefined) : undefined;
      installationIdByOwner[owner] = app?.installationFor(owner);
    }
    const capabilityRows = repoCapabilityRows(access.repos, access.repoCapabilities, grantedByOwner);

    const evidence = permissionEvidence(rows, grants, window);
    const proposals = proposePermissionChanges(evidence, input.direction ?? "both");
    let report = renderPermissionProposals(evidence, proposals);
    report += `\n\n## GitHub repo capability sets\n${renderRepoCapabilityRows(capabilityRows, installationIdByOwner).join("\n")}`;
    if (truncated) {
      report = `⚠ Row cap (${ROW_CAP}/action) hit — usage is UNDER-counted in this window, so tightening proposals are unproven. Re-run with a shorter \`days\`.\n\n${report}`;
    }
    if (!truncated && evidence.activity.awsExec < MIN_TIGHTEN_OBSERVATIONS && evidence.usage.some((u) => u.kind === "aws-role")) {
      report += `\n\n(AWS grants were not evaluated for tightening: ${evidence.activity.awsExec} execution(s) in the window is under the ${MIN_TIGHTEN_OBSERVATIONS}-row floor — an unused grant is only evidence when something else was used.)`;
    }

    await auditToolAction(bindable, "permission.fit_report", {
      domain,
      days,
      direction: input.direction ?? "both",
      rowsConsidered: evidence.rowsConsidered,
      grantsExamined: evidence.usage.length,
      widen: proposals.filter((p) => p.direction === "widen").length,
      tighten: proposals.filter((p) => p.direction === "tighten").length,
      ...(truncated ? { truncated: true } : {}),
    });

    return {
      domain,
      window: { since: window.since, until: window.until, days: window.days },
      rowsConsidered: evidence.rowsConsidered,
      truncated,
      grantsExamined: evidence.usage.length,
      repoCapabilities: capabilityRows.map((r) => ({
        repo: r.repo,
        capability: r.capability,
        declared: r.declared,
        installationSupports: (!r.fit.reported ? "unreported" : r.fit.ok ? "yes" : "no") as "yes" | "no" | "unreported",
      })),
      proposals: proposals.map((p) => ({
        id: p.id,
        direction: p.direction,
        subject: p.subject,
        summary: p.summary,
        evidence: [...p.evidence],
        ...(p.diff !== undefined ? { diff: p.diff.text } : {}),
        ...(p.remedy !== undefined ? { remedy: p.remedy } : {}),
      })),
      report,
    };
  },
});
