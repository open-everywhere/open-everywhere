import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { humanActingSupport, isHumanActing } from "@open-everywhere/core/agent/access/connector-credentials.js";
import { credentialGrantConnectors } from "@open-everywhere/core/agent/access/credential-grant.js";
import {
  checkOwnAccountGateSites,
  findOwnAccountGateSites,
  OWN_ACCOUNT_GATE_CALL,
  type OwnAccountGateFile,
} from "@open-everywhere/core/agent/access/own-account-gate-manifest.js";
import { loadConnectorCredentials } from "../agent/access/connector-credentials.js";

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

const files: OwnAccountGateFile[] = [];
for (const dir of roots) {
  for (const full of tsFilesUnder(dir)) files.push({ file: relative(root, full), source: readFileSync(full, "utf8") });
}

const connectors = credentialGrantConnectors();

const humanActing = loadConnectorCredentials()
  .filter((c) => humanActingSupport(c) === "supported" && c.credentials.some((cred) => isHumanActing(cred)))
  .map((c) => c.connector);

if (listOnly) {
  console.log(`connectors admitting a credential grant: ${connectors.join(", ") || "(none)"}`);
  console.log(`connectors declaring a human-acting credential family: ${humanActing.join(", ") || "(none)"}`);
  for (const site of findOwnAccountGateSites(files)) {
    console.log(`  ${site.connector ?? "(unmarked)"}  ${site.file}:${site.line}`);
  }
  process.exit(0);
}

const problems = checkOwnAccountGateSites(files, connectors, humanActing);

if (problems.length > 0) {
  console.error(`✗ own-account-gate-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ own-account-gate-lint: every connector CREDENTIAL_GRANT_ROLES admits has a gated read site, and every gate names a ` +
    `connector one of the two reviewed lists recognises — ${connectors.length} admitting a credential grant, ` +
    `${humanActing.length} declaring a human-acting credential family, ${findOwnAccountGateSites(files).length} ` +
    `\`${OWN_ACCOUNT_GATE_CALL}\` call(s), scanned across ${files.length} core-, app- and bundle-authored files.`,
);
