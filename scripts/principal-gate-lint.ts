import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATTENDEDNESS_DERIVATION,
  checkApprovalAuthoritySites,
  checkAttendednessSites,
  checkPrincipalGates,
  checkUnattendedDispatch,
  findAttendednessSites,
  findPrincipalGates,
  findProposeAliasShapeProblems,
  findUnattendedDispatchSites,
  type AttendednessSite,
  type PrincipalGate,
  type UnattendedDispatchSite,
} from "@open-everywhere/core/agent/access/principal-gate-manifest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const listOnly = process.argv.includes("--list");

function tsFilesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "generated") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const roots = [join(root, "packages", "core", "agent"), join(root, "agent")].filter((d) => {
  try {
    return statSync(d).isDirectory();
  } catch {
    return false;
  }
});
const providersDir = join(root, "packages", "providers");
try {
  for (const p of readdirSync(providersDir)) {
    const agentDir = join(providersDir, p, "agent");
    try {
      if (statSync(agentDir).isDirectory()) roots.push(agentDir);
    } catch {
    }
  }
} catch {
}

const files = roots.flatMap((r) => tsFilesUnder(r));
if (files.length === 0) {
  console.error(`✗ principal-gate-lint: found no sources under ${roots.map((r) => relative(root, r)).join(", ")} — refusing to report clean against an unread tree`);
  process.exit(1);
}

const gates: PrincipalGate[] = files.flatMap((f) => findPrincipalGates(relative(root, f), readFileSync(f, "utf8")));
const sites: UnattendedDispatchSite[] = files.flatMap((f) => findUnattendedDispatchSites(relative(root, f), readFileSync(f, "utf8")));
const attended: AttendednessSite[] = files.flatMap((f) => findAttendednessSites(relative(root, f), readFileSync(f, "utf8")));
const approvalAuthority = attended.filter((site) => site.shape === "propose");
const aliasShapes = files.flatMap((f) => findProposeAliasShapeProblems(relative(root, f), readFileSync(f, "utf8")));

if (listOnly) {
  for (const g of [...gates].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))) {
    const verdict = g.intent ?? g.unknownIntent ?? "UNMARKED";
    console.log(`${verdict.toUpperCase().padEnd(15)} ${g.file}:${g.line}  ${g.expr.padEnd(16)} ${g.reason ?? ""}`);
  }
  for (const s of [...sites].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))) {
    console.log(`${(s.viaFireAuth ? "FIRE-AUTH" : "INLINE-BAG").padEnd(15)} ${s.file}:${s.line}  service-principal dispatch`);
  }
  for (const a of [...attended].sort((x, y) => (x.file === y.file ? x.line - y.line : x.file.localeCompare(y.file)))) {
    const value = a.exempt
      ? a.exemptReason ?? ""
      : a.shape === "eve-approval"
        ? a.derivedInFile === true
          ? `${ATTENDEDNESS_DERIVATION} (in file)`
          : "MISSING"
        : a.expr ?? "MISSING";
    console.log(`${(a.exempt ? "EXEMPT" : "ATTENDEDNESS").padEnd(15)} ${a.file}:${a.line}  ${a.shape.padEnd(13)} ${value}`);
  }
  for (const a of [...approvalAuthority].sort((x, y) => (x.file === y.file ? x.line - y.line : x.file.localeCompare(y.file)))) {
    console.log(`${(a.authorityExempt ? "HEADLESS" : "AUTHORITY-CTX").padEnd(15)} ${a.file}:${a.line}  ${a.authorityContext ?? a.authorityExemptReason ?? "MISSING"}`);
  }
  console.log(`\n${gates.length} principal refusal gate(s) + ${sites.length} service-principal dispatch site(s) + ${attended.length} attendedness site(s) + ${approvalAuthority.length} approval-authority site(s) over ${files.length} source file(s).`);
  process.exit(0);
}

const defects = [
  ...checkPrincipalGates(gates),
  ...checkUnattendedDispatch(sites),
  ...checkAttendednessSites(attended),
  ...checkApprovalAuthoritySites(approvalAuthority),
  ...aliasShapes.map((a) => ({
    rule: "propose-alias-shape",
    file: a.file,
    line: a.line,
    message:
      `this declaration names requestApproval on its right-hand side in a shape the alias reader cannot classify, so a call through it would NOT be checked for a chain: bag — \`${a.text}\`. ` +
      `Bind it as a plain reference (\`const fn = deps.requestApproval ?? requestApproval\`), or teach principal-gate-manifest.ts the new shape under review.`,
  })),
];
if (defects.length > 0) {
  console.error(`✗ principal-gate-lint: ${defects.length} problem(s) — an undeclared or contradictory principal gate, an unattended origin with no marker, or an attendedness signal that is not derived:`);
  for (const d of defects) console.error(`  - [${d.rule}] ${d.file}:${d.line} — ${d.message}`);
  console.error(
    `\n  Why this is a hard error: a "presence" gate written against the BOUND principal refuses nobody, because a\n` +
      `  triggered routine fire binds as its routine's attested creator — a real person's id. That exact shape shipped\n` +
      `  three times (OPE-269, OPE-272, OPE-273). The marker is how the choice stops being implicit.`,
  );
  process.exit(1);
}

const presence = gates.filter((g) => g.intent === "presence").length;
const exempt = attended.filter((a) => a.exempt).length;
const eve = attended.filter((a) => a.shape === "eve-approval" && !a.exempt).length;
const headlessAuthority = approvalAuthority.filter((a) => a.authorityExempt).length;
console.log(
  `✓ principal-gate-lint: ${gates.length} principal refusal gate(s), every one declaring its intent and reading an accessor that can deliver it ` +
    `(${presence} presence — refuse an unattended fire; ${gates.length - presence} accountability — somebody nameable must exist); ` +
    `${sites.length} service-principal dispatch site(s), every one building its bag through fire-auth (OPE-278); ` +
    `${attended.length - exempt - eve} attendedness site(s) deriving through unattendedOf(ctx); ` +
    `${eve} eve ApprovalPolicy site(s) whose FILE derives it (OPE-1273 — the grain is the file, not the site); ` +
    `${exempt} attendedness-exempt with a stated reason (OPE-440); ` +
    `${approvalAuthority.length - headlessAuthority} approval proposal site(s) carrying exact wake authority and ${headlessAuthority} headless exemption(s).`,
);
