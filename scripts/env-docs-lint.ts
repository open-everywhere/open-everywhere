import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_READ_ALLOWLIST, DYNAMIC_ENV_READ_SITES, auditDynamicEnvReads, auditEnvReads } from "./env-read-allowlist.js";
import { collectExportedNameConstants, scanComputedEnvReads, type DynamicEnvRead } from "./env-read-scan.js";
import { toPosixPath } from "./posix-path.js";

const CODE_ROOTS = ["agent", "packages"];
const DOC_ROOTS = ["docs"];
const DOC_FILES = [".env.example", ".env.e2e.example"];

const GRANDFATHERED = new Set<string>([]);

const listMode = process.argv.includes("--list");

function filesUnder(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) filesUnder(p, accept, out);
    else if (accept(entry)) out.push(toPosixPath(p));
  }
  return out;
}

const codeFiles = CODE_ROOTS.flatMap((root) =>
  filesUnder(root, (name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith("-test.ts")),
).filter((p) => p.split("/").includes("agent"));

const sources = codeFiles.map((file) => [file, readFileSync(file, "utf8")] as const);

const reads = new Map<string, string[]>();
function recordRead(name: string, file: string): void {
  if (!reads.has(name)) reads.set(name, []);
  const where = reads.get(name);
  if (where && !where.includes(file)) where.push(file);
}

for (const [file, source] of sources) {
  for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) recordRead(m[1], file);
}

const exportedNames = collectExportedNameConstants(sources);
const dynamicSites: DynamicEnvRead[] = [];
let computedReadCount = 0;
for (const [file, source] of sources) {
  const scan = scanComputedEnvReads(file, source, exportedNames);
  for (const r of scan.resolved) {
    if (!reads.get(r.name)?.includes(r.file)) computedReadCount++;
    recordRead(r.name, r.file);
  }
  dynamicSites.push(...scan.dynamic);
}

const DOC_SCAN_EXCLUDE_PREFIX = "docs/inventory/";
const isAuditInventory = (file: string): boolean => file.startsWith(DOC_SCAN_EXCLUDE_PREFIX);

const documentation = [
  ...DOC_ROOTS.flatMap((root) => filesUnder(root, (name) => name.endsWith(".md"))).filter(
    (file) => !isAuditInventory(file)
  ),
  ...DOC_FILES,
]
  .map((p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");

const documented = (name: string): boolean => documentation.includes(name);

const reds: string[] = [];
let documentedCount = 0;

for (const [name, where] of [...reads].sort((a, b) => a[0].localeCompare(b[0]))) {
  const isDocumented = documented(name);
  if (isDocumented) documentedCount++;
  if (listMode) {
    const status = isDocumented ? "documented" : GRANDFATHERED.has(name) ? "GRANDFATHERED" : "UNDOCUMENTED";
    const klass = ENV_READ_ALLOWLIST.get(name)?.klass ?? "NOT-ALLOWLISTED";
    console.log(`  ${status.padEnd(14)} ${klass.padEnd(18)} ${name}  (${where.length} file(s), e.g. ${where[0]})`);
  }
  if (!isDocumented && !GRANDFATHERED.has(name)) {
    reds.push(
      `UNDOCUMENTED ENV: the runtime reads process.env.${name} (${where[0]}${where.length > 1 ? ` +${where.length - 1} more` : ""}) ` +
        `but no page under docs/ and neither .env.example nor .env.e2e.example mentions it. An operator cannot set what ` +
        `isn't written down, so this lands as a runtime surprise on a deployed agent. Document it (.env.example + ` +
        `docs/deploy/configuration-reference.md), or — if it is deliberately internal — add it to GRANDFATHERED in ` +
        `scripts/env-docs-lint.ts WITH a reason.`,
    );
  }
}

for (const name of GRANDFATHERED) {
  if (!reads.has(name)) {
    reds.push(
      `STALE GRANDFATHER: ${name} is listed in scripts/env-docs-lint.ts but nothing in the runtime reads it any more — ` +
        `delete the entry.`,
    );
    continue;
  }
  if (documented(name)) {
    reds.push(
      `GRANDFATHER CLEARED: ${name} is now documented — delete it from GRANDFATHERED in scripts/env-docs-lint.ts so the ` +
        `list keeps shrinking.`,
    );
  }
}

reds.push(...auditEnvReads(reads));

reds.push(...auditDynamicEnvReads(dynamicSites));

const REVERSE_SCAN_ROOTS = ["agent", "packages", "scripts", "tests", "deploy"];

const REVERSE_EXEMPT = new Map<string, string>([
  [
    "EVE_TELEMETRY_DISABLED",
    "read by eve's own CLI telemetry (node_modules/eve/dist/src/cli/telemetry/index.js, `isEnabled`). This repo only sets it, in package.json scripts and the Dockerfiles; `npm run lint:eve-telemetry` pins both (OPE-2526).",
  ],
  [
    "LINEAR_WEBHOOK_SECRET",
    "read by eve's own bundled Linear channel handler (node_modules/eve/dist/src/public/channels/linear/auth.js) — the native webhook signature check is eve's, not this repo's source.",
  ],
  [
    "MICROSOFT_TENANT_ID",
    "read by eve's own bundled Teams channel handler (node_modules/eve/dist/src/public/channels/teams/api.js).",
  ],
  [
    "OE_EGRESS_MITM",
    "read by deploy/egress-proxy/entrypoint.sh, a shell provisioning script outside every .ts/.js scan root, not by application code.",
  ],
]);

const REVERSE_SCAN_SELF = [
  "scripts/env-docs-lint.ts",
  "scripts/env-read-allowlist.ts",
  "scripts/env-read-allowlist-test.ts",
  "scripts/env-read-scan.ts",
];
const LINT_SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const self of REVERSE_SCAN_SELF) {
  if (!existsSync(join(LINT_SOURCE_ROOT, self))) {
    reds.push(
      `STALE REVERSE_SCAN_SELF: ${self} is excluded from the reverse arm's scan in scripts/env-docs-lint.ts but no ` +
        `such file exists — it was renamed or deleted. Update the list, or the file it names is counted as a reader ` +
        `of every env name it quotes.`,
    );
  }
}

function reverseUsedNames(): Set<string> {
  const files = REVERSE_SCAN_ROOTS.flatMap((root) =>
    filesUnder(root, (name) => (name.endsWith(".ts") || name.endsWith(".js")) && !name.endsWith(".d.ts")),
  ).filter((p) => !REVERSE_SCAN_SELF.includes(p));
  const used = new Set<string>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const m of content.matchAll(/\.([A-Z][A-Z0-9_]{2,})\b/g)) used.add(m[1]);
    for (const m of content.matchAll(/["']([A-Z][A-Z0-9_]{2,})["']/g)) used.add(m[1]);
  }
  return used;
}

const DOC_TABLES_NOT_ENV = new Map<string, string>([
  ["docs/dev/e2e-fixtures.md", "a generated room inventory — its first column is a vendor room id, not an env name."],
]);
for (const file of DOC_TABLES_NOT_ENV.keys()) {
  if (!existsSync(join(LINT_SOURCE_ROOT, file))) {
    reds.push(
      `STALE DOC_TABLES_NOT_ENV: ${file} is excluded from the reverse arm's row scan in scripts/env-docs-lint.ts ` +
        `but no such file exists — it was renamed or deleted. Update the list, or its table columns are read as env rows again.`,
    );
  }
}

if (!existsSync(join(LINT_SOURCE_ROOT, DOC_SCAN_EXCLUDE_PREFIX))) {
  reds.push(
    `STALE DOC_SCAN_EXCLUDE_PREFIX: ${DOC_SCAN_EXCLUDE_PREFIX} is excluded from this lint's documentation corpus ` +
      `in scripts/env-docs-lint.ts but no such directory exists — it was renamed or deleted. Update the prefix, or ` +
      `a renamed inventory page counts as documentation again and arm 1 goes permanently green.`
  );
}

function documentedEnvNames(): Set<string> {
  const names = new Set<string>();
  for (const file of DOC_ROOTS.flatMap((root) => filesUnder(root, (name) => name.endsWith(".md")))) {
    if (DOC_TABLES_NOT_ENV.has(file) || isAuditInventory(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)) names.add(m[1]);
  }
  for (const file of DOC_FILES) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of content.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) names.add(m[1]);
  }
  return names;
}

const documentedNames = documentedEnvNames();
const usedAnywhere = reverseUsedNames();
const reverseReds: string[] = [];

for (const name of [...documentedNames].sort()) {
  if (usedAnywhere.has(name) || REVERSE_EXEMPT.has(name)) continue;
  reverseReds.push(
    `STALE ROW: \`${name}\` is documented (a docs/ table row or .env.example) but nothing reads it — ` +
      `not the runtime, not scripts/, not tests/, not deploy/. Delete the row, or if the true reader is ` +
      `real but invisible to a source scan (a vendor bundle, a shell script outside the scan roots), add ` +
      `it to REVERSE_EXEMPT in scripts/env-docs-lint.ts WITH a reason.`,
  );
}

for (const name of REVERSE_EXEMPT.keys()) {
  if (!documentedNames.has(name)) {
    reverseReds.push(
      `STALE REVERSE_EXEMPT: ${name} is listed in scripts/env-docs-lint.ts but no doc row documents it ` +
        `any more — delete the entry.`,
    );
  }
}

if (listMode) {
  for (const name of [...documentedNames].sort()) {
    const status = usedAnywhere.has(name) ? "read" : REVERSE_EXEMPT.has(name) ? "EXEMPT" : "STALE";
    if (status !== "read") console.log(`  reverse ${status.padEnd(8)} ${name}`);
  }
}

reds.push(...reverseReds);

if (reds.length > 0) {
  console.error(`✗ env-docs: ${reds.length} problem(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

const pendingMigration = [...ENV_READ_ALLOWLIST.values()].filter((e) => e.klass === "pending-migration").length;

console.log(
  `✓ env-docs: ${reads.size} env name(s) read by the runtime — ${documentedCount} documented, ` +
    `${GRANDFATHERED.size} grandfathered (frozen 2026-08-10, must only shrink), 0 new gaps. ` +
    `${computedReadCount} name-in-file read(s) reached their name through a COMPUTED key (OPE-1160). ` +
    `Reverse arm: ${documentedNames.size} documented name(s), ${REVERSE_EXEMPT.size} exempt, 0 stale rows. ` +
    `Allowlist arm: ${ENV_READ_ALLOWLIST.size} allowed, ${pendingMigration} pending migration to settings ` +
    `(OPE-1153, must only shrink), 0 unallowed reads. ` +
    `Dynamic-site arm: ${dynamicSites.length} unresolvable read site(s), ${DYNAMIC_ENV_READ_SITES.size} excused ` +
    `(must only shrink).`,
);
