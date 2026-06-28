import { readAudit, auditRoot, type AuditFilter } from "../agent/audit/audit.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const filter: AuditFilter = {
  org: arg("org"),
  workspace: arg("workspace"),
  surface: arg("surface"),
  action: arg("action"),
  principalId: arg("principal"),
  since: arg("since"),
  limit: arg("limit") ? Number(arg("limit")) : 200,
};

const rows = await readAudit(filter);

console.log(`\nAudit log: ${auditRoot()}`);
const scope = [filter.org && `org=${filter.org}`, filter.action && `action=${filter.action}`, filter.principalId && `who=${filter.principalId}`, filter.since && `since=${filter.since}`]
  .filter(Boolean)
  .join("  ");
console.log(scope ? `Filter: ${scope}` : "Filter: (all)");
console.log("─".repeat(96));

if (rows.length === 0) {
  console.log("  (no matching audit entries)");
} else {
  for (const e of rows) {
    const where = [e.org, e.platform, e.workspace, e.surface].filter(Boolean).join("/");
    const who = e.principalId ? `@${e.principalId}` : "—";
    const detail = e.detail ? JSON.stringify(e.detail) : "";
    console.log(`  ${e.ts}  ${e.action.padEnd(16)} ${who.padEnd(12)} ${where}`);
    if (detail) console.log(`  ${" ".repeat(20)} ${detail}`);
  }
  console.log("  " + "─".repeat(60));
  console.log(`  ${rows.length} entr${rows.length === 1 ? "y" : "ies"}${filter.limit && rows.length === filter.limit ? ` (capped at --limit ${filter.limit})` : ""}`);
}
console.log();
