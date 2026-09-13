import { readAudit, auditRoot, type AuditFilter, type AuditEntry } from "../agent/audit/audit.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { deploymentOrg } from "../agent/identity/deployment-identity.js";
import { connectOperatorStoreForCli } from "./operator-store-connect.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const allOrgs = flag("all-orgs");
if (allOrgs && arg("org") !== undefined) {
  console.error("audit: --all-orgs and --org name different reads — pass one of them, not both.");
  process.exit(2);
}

const target = await connectOperatorStoreForCli();

const filter: AuditFilter = {
  org: deploymentOrg(),
  workspace: arg("workspace"),
  surface: arg("surface"),
  action: arg("action"),
  principalId: arg("principal"),
  since: arg("since"),
  limit: arg("limit") ? Number(arg("limit")) : 200,
};

const orgs = allOrgs ? await getOperationalStore().listAuditOrgs() : [filter.org];
const rows: AuditEntry[] = [];
let capped = false;
for (const org of orgs) {
  const page = await readAudit({ ...filter, org });
  if (filter.limit !== undefined && filter.limit > 0 && page.length >= filter.limit) capped = true;
  rows.push(...page);
}
if (allOrgs) rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

console.log(`\nAudit log: ${auditRoot()}   store: ${target.label}`);
const scope = [allOrgs ? `orgs=${orgs.length === 0 ? "(none)" : orgs.join(",")}` : `org=${filter.org}`, filter.action && `action=${filter.action}`, filter.principalId && `who=${filter.principalId}`, filter.since && `since=${filter.since}`]
  .filter(Boolean)
  .join("  ");
console.log(`Filter: ${scope}`);
console.log("─".repeat(96));

if (rows.length === 0) {
  console.log("  (no matching audit entries)");
  if (!allOrgs) {
    const known = await getOperationalStore().listAuditOrgs();
    const others = known.filter((o) => o !== filter.org);
    if (others.length > 0) {
      console.log(`  (this store holds rows for: ${others.join(", ")} — name one with --org, or pass --all-orgs)`);
    }
  }
} else {
  for (const e of rows) {
    const where = [e.org, e.platform, e.workspace, e.surface].filter(Boolean).join("/");
    const who = e.principalId ? `@${e.principalId}` : "—";
    const detail = e.detail ? JSON.stringify(e.detail) : "";
    console.log(`  ${e.ts}  ${e.action.padEnd(16)} ${who.padEnd(12)} ${where}`);
    if (detail) console.log(`  ${" ".repeat(20)} ${detail}`);
  }
  console.log("  " + "─".repeat(60));
  console.log(`  ${rows.length} entr${rows.length === 1 ? "y" : "ies"}${capped ? ` (capped at --limit ${filter.limit}${allOrgs ? " per org" : ""})` : ""}`);
}
console.log();
