import { scanAuditActions, KNOWN_ROAD_NAMES } from "./audit-action-scan-lib.js";
import {
  CONSEQUENTIAL_AUDIT_ACTIONS,
  DYNAMIC_ACTION_SITES,
  declaredAuditActions,
} from "../packages/core/agent/audit/action-registry.js";

const MIN_PLAUSIBLE_ACTIONS = 100;

export interface AuditActionLintFinding {
  readonly rule: "undeclared" | "undeclared-dynamic-site" | "unknown-road" | "dangling-declaration" | "stale-declaration";
  readonly detail: string;
}

export function auditActionFindings(
  scan: Pick<ReturnType<typeof scanAuditActions>, "actions" | "unresolved" | "forwardingHelpers">,
  declared: readonly string[],
  dynamicSites: readonly { readonly file: string; readonly emits: readonly string[] }[],
  opts: { readonly strict?: boolean } = {},
): readonly AuditActionLintFinding[] {
  const findings: AuditActionLintFinding[] = [];
  const declaredSet = new Set(declared);

  for (const action of scan.actions) {
    if (!declaredSet.has(action)) {
      findings.push({
        rule: "undeclared",
        detail: `the tree emits "${action}" but the registry does not declare it — add it to CONSEQUENTIAL_AUDIT_ACTIONS (with its detail fields) or OPERATIONAL_AUDIT_ACTIONS`,
      });
    }
  }

  const declaredSiteFiles = new Set(dynamicSites.map((s) => s.file));
  for (const file of new Set(scan.unresolved.map((u) => u.file))) {
    if (!declaredSiteFiles.has(file)) {
      const expressions = [...new Set(scan.unresolved.filter((u) => u.file === file).map((u) => u.expression))];
      findings.push({
        rule: "undeclared-dynamic-site",
        detail: `${file} names its audit action at run time (${expressions.join(", ")}) and is not in DYNAMIC_ACTION_SITES — declare the site and the names it can emit`,
      });
    }
  }

  for (const helper of new Set(scan.forwardingHelpers.map((h) => `${h.name} (${h.file})`))) {
    const name = helper.slice(0, helper.indexOf(" ("));
    if (!KNOWN_ROAD_NAMES.includes(name)) {
      findings.push({
        rule: "unknown-road",
        detail: `${helper} forwards a parameter into an audit write, so it is a road the scanner must read — add it to KNOWN_ROADS in scripts/audit-action-scan-lib.ts, or stop forwarding`,
      });
    }
  }

  for (const site of dynamicSites) {
    if (site.emits.length === 0) {
      findings.push({ rule: "dangling-declaration", detail: `${site.file} declares an empty emits list — say which actions it can write` });
      continue;
    }
    for (const action of site.emits) {
      if (!declaredSet.has(action)) {
        findings.push({
          rule: "dangling-declaration",
          detail: `${site.file} declares it emits "${action}", which no registry table carries`,
        });
      }
    }
  }

  if (opts.strict === true) {
    const emitted = new Set<string>(scan.actions);
    for (const site of dynamicSites) for (const a of site.emits) emitted.add(a);
    for (const action of declared) {
      if (!emitted.has(action)) {
        findings.push({ rule: "stale-declaration", detail: `the registry declares "${action}" but nothing in the tree emits it` });
      }
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const strict = process.argv.includes("--strict");
  const scan = scanAuditActions(process.cwd());

  if (scan.actions.length < MIN_PLAUSIBLE_ACTIONS) {
    console.error(
      `✗ lint:audit-actions — the scan resolved only ${scan.actions.length} action(s) across ${scan.filesScanned} file(s). That is the SCANNER broken, not a tree that emits nothing; a report of "no findings" from here would be false.`,
    );
    process.exit(1);
  }

  const findings = auditActionFindings(scan, declaredAuditActions(), DYNAMIC_ACTION_SITES, { strict });
  const notExercised = CONSEQUENTIAL_AUDIT_ACTIONS.filter((d) => d.notExercised !== undefined).length;

  if (findings.length === 0) {
    console.log(
      `✓ lint:audit-actions — ${scan.actions.length} emitted action(s) across ${scan.filesScanned} file(s), all declared; ` +
        `${CONSEQUENTIAL_AUDIT_ACTIONS.length} consequential row(s) under contract (${notExercised} declared not-exercised), ` +
        `${DYNAMIC_ACTION_SITES.length} run-time-named site(s) declared.`,
    );
    return;
  }

  console.error(`✗ lint:audit-actions — ${findings.length} finding(s):`);
  for (const f of findings) console.error(`  [${f.rule}] ${f.detail}`);
  console.error(
    "\nThe registry is packages/core/agent/audit/action-registry.ts. An audit row nobody declares is a row nobody notices losing.",
  );
  process.exit(1);
}

const invokedDirectly = process.argv[1]?.endsWith("audit-actions-lint.ts") === true;
if (invokedDirectly) {
  try {
    await main();
  } catch (err: unknown) {
    console.error(`✗ lint:audit-actions failed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  }
}
