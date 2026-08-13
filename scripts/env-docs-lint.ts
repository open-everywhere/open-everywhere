import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
    else if (accept(entry)) out.push(p);
  }
  return out;
}

const codeFiles = CODE_ROOTS.flatMap((root) =>
  filesUnder(root, (name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith("-test.ts")),
).filter((p) => p.split("/").includes("agent"));

const reads = new Map<string, string[]>();
for (const file of codeFiles) {
  for (const m of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    if (!reads.has(m[1])) reads.set(m[1], []);
    const where = reads.get(m[1]);
    if (where && !where.includes(file)) where.push(file);
  }
}

const documentation = [
  ...DOC_ROOTS.flatMap((root) => filesUnder(root, (name) => name.endsWith(".md"))),
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
    console.log(`  ${status.padEnd(14)} ${name}  (${where.length} file(s), e.g. ${where[0]})`);
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

const REVERSE_SCAN_ROOTS = ["agent", "packages", "scripts", "tests", "deploy"];

const REVERSE_EXEMPT = new Map<string, string>([
  [
    "LINEAR_WEBHOOK_SECRET",
    "read by eve's own bundled Linear channel handler (node_modules/eve/dist/src/public/channels/linear/auth.js) — the native webhook signature check is eve's, not this repo's source.",
  ],
  [
    "MICROSOFT_TENANT_ID",
    "read by eve's own bundled Teams channel handler (node_modules/eve/dist/src/public/channels/teams/api.js).",
  ],
  [
    "OTEL_EXPORTER_OTLP_HEADERS",
    "the standard OTel var, read by eve's bundled @vercel/otel exporter — same class as the Host-injected AWS_REGION/NODE_ENV rows above, just via a vendored dependency instead of the platform.",
  ],
  [
    "OE_EGRESS_MITM",
    "read by deploy/egress-proxy/entrypoint.sh, a shell provisioning script outside every .ts/.js scan root, not by application code.",
  ],
]);

function reverseUsedNames(): Set<string> {
  const files = REVERSE_SCAN_ROOTS.flatMap((root) =>
    filesUnder(root, (name) => (name.endsWith(".ts") || name.endsWith(".js")) && !name.endsWith(".d.ts")),
  );
  const used = new Set<string>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const m of content.matchAll(/\.([A-Z][A-Z0-9_]{2,})\b/g)) used.add(m[1]);
    for (const m of content.matchAll(/["']([A-Z][A-Z0-9_]{2,})["']/g)) used.add(m[1]);
  }
  return used;
}

function documentedEnvNames(): Set<string> {
  const names = new Set<string>();
  for (const file of DOC_ROOTS.flatMap((root) => filesUnder(root, (name) => name.endsWith(".md")))) {
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

console.log(
  `✓ env-docs: ${reads.size} env name(s) read by the runtime — ${documentedCount} documented, ` +
    `${GRANDFATHERED.size} grandfathered (frozen 2026-08-10, must only shrink), 0 new gaps. ` +
    `Reverse arm: ${documentedNames.size} documented name(s), ${REVERSE_EXEMPT.size} exempt, 0 stale rows.`,
);
