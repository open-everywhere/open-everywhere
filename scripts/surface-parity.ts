import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";
import { writeFileIfChanged } from "./write-if-changed.js";

import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerEmailProvider } from "@open-everywhere/provider-email/agent/register.js";
import { registerGoogleChatProvider } from "@open-everywhere/provider-google-chat/agent/register.js";
import {
  SURFACE_CAPABILITIES,
  checkSurfaceParity,
  clearProviderSelection,
  registeredCapabilityManifestPlatforms,
  registeredIdentityMapperPlatforms,
  registeredPostArmPlatforms,
  registeredReactionSurfaces,
  registeredSearchConnectors,
  renderParityMatrix,
  renderParityTable,
  supportedReadPlatforms,
  surfaceMessageOps,
  surfaceParityFor,
  wakeOriginCodec,
  type CapabilityProbe,
  type SurfaceParityDeclaration,
} from "@open-everywhere/core/agent/adapter-api.js";

import { hasApprovalCardPath, hasJudgeLiftNoticePath } from "@open-everywhere/core/agent/approvals/flow.js";
import { hasThreadDoneReactionPath } from "@open-everywhere/core/agent/channels/thread-seat-close.js";

import { SETTINGS_OVERRIDES } from "../agent/settings/settings.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const contractFlagAt = process.argv.indexOf("--contract");
const CONTRACT =
  contractFlagAt >= 0 && process.argv[contractFlagAt + 1] !== undefined
    ? process.argv[contractFlagAt + 1]!
    : "docs/extending/chat-surface-contract.md";

if (contractFlagAt >= 0 && !check) {
  console.error("✗ surface-parity: --contract is a verification affordance and requires --check; it never writes.");
  process.exit(1);
}

const PLATFORMS = ["slack", "discord", "teams", "github", "linear", "notion", "email", "google-chat"] as const;

clearProviderSelection();

registerSlackProvider();
registerDiscordProvider();
registerTeamsProvider();
registerGithubProvider();
registerLinearProvider();
registerNotionProvider();
registerEmailProvider();
registerGoogleChatProvider();

function engagementSeamPlatforms(): ReadonlySet<string> {
  const wired = new Set<string>();
  for (const platform of PLATFORMS) {
    const dir = join(root, "packages", "providers", platform, "agent");
    if (sourcesReference(dir, ENGAGEMENT_IMPORT)) wired.add(platform);
  }
  return wired;
}

const ENGAGEMENT_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\b(?:markThreadEngaged|shouldDeliverReply)\b[^}]*\}\s*from\s*["'][^"']*adapter-api\.js["']/su;

function ownedThreadIngressPlatforms(): ReadonlySet<string> {
  const wired = new Set<string>();
  for (const platform of PLATFORMS) {
    const dir = join(root, "packages", "providers", platform, "agent");
    if (sourcesReference(dir, OWNED_THREAD_INGRESS_IMPORT) && sourcesReference(dir, OWNED_THREAD_INGRESS_CALL)) wired.add(platform);
  }
  return wired;
}

const OWNED_THREAD_INGRESS_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\bdivertInboundToUnifiedWindow\b[^}]*\}\s*from\s*["'][^"']*adapter-api\.js["']/su;

const OWNED_THREAD_INGRESS_CALL = /\bawait\s+divertInboundToUnifiedWindow\s*\(/su;

function engagedRowPromotionPlatforms(): ReadonlySet<string> {
  const wired = new Set<string>();
  for (const platform of PLATFORMS) {
    const dir = join(root, "packages", "providers", platform, "agent");
    if (sourcesReference(dir, ENGAGED_ROW_PROMOTION_DEF) && sourcesReference(dir, ENGAGED_ROW_PROMOTION_CALL)) wired.add(platform);
  }
  return wired;
}

const ENGAGED_ROW_PROMOTION_DEF = /\?\s*"thread-follow"\s*:\s*addressing\b/su;

const ENGAGED_ROW_PROMOTION_CALL = /\baddressing:\s*\w*WakeAddressing\s*\(/su;

const CONTEXT_ADMISSION_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\badmitContextLines\b[^}]*\}\s*from\s*["'][^"']*adapter-api\.js["']/su;
const CONTEXT_ADMISSION_CALL = /\badmitContextLines\s*\(/su;
const CONTEXT_LINE_FILL = /\bcontextLines\s*:/su;

function contextAdmissionPlatforms(): ReadonlySet<string> {
  const wired = new Set<string>();
  for (const platform of PLATFORMS) {
    const dir = join(root, "packages", "providers", platform, "agent");
    if (!sourcesReference(dir, CONTEXT_LINE_FILL)) continue;
    if (sourcesReference(dir, CONTEXT_ADMISSION_IMPORT) && sourcesReference(dir, CONTEXT_ADMISSION_CALL)) wired.add(platform);
  }
  return wired;
}

const COVER_WAKE_IMPORT = /import\s*(?:type\s*)?\{[^}]*\bcoverForWake\b[^}]*\}\s*from\s*["'][^"']*adapter-api\.js["']/su;
const COVER_WAKE_CALL = /\bawait\s+coverForWake\s*\(/su;

function coverWakePlatforms(): ReadonlySet<string> {
  const wired = new Set<string>();
  for (const platform of PLATFORMS) {
    const dir = join(root, "packages", "providers", platform, "agent");
    if (sourcesReference(dir, COVER_WAKE_IMPORT) && sourcesReference(dir, COVER_WAKE_CALL)) wired.add(platform);
  }
  return wired;
}

function sourcesReference(dir: string, pattern: RegExp): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (sourcesReference(p, pattern)) return true;
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith("-test.ts")) continue;
    if (entry === "docs-generated.ts" || entry === "surface-parity.ts") continue;
    if (pattern.test(readFileSync(p, "utf8"))) return true;
  }
  return false;
}

function setOf(platforms: Iterable<string>): ReadonlySet<string> {
  return new Set([...platforms].filter((p) => (PLATFORMS as readonly string[]).includes(p)));
}

const SOURCE_SCAN_PROBES = [
  "ambient-engagement-seam",
  "owned-thread-ingress",
  "engaged-row-promotion",
  "seat-context-admission",
  "out-of-office-cover",
] as const;

const PROBES: CapabilityProbe = new Map<string, ReadonlySet<string>>([
  ["identity-mapper", setOf(registeredIdentityMapperPlatforms())],
  ["capability-manifest", setOf(registeredCapabilityManifestPlatforms())],
  ["post-arm", setOf(registeredPostArmPlatforms())],
  ["wake-origin-codec", setOf(PLATFORMS.filter((p) => wakeOriginCodec(p) !== undefined))],
  [
    "origin-placement-carry",
    setOf(
      PLATFORMS.filter((p) => {
        const codec = wakeOriginCodec(p);
        return codec?.placementRef !== undefined && codec.carryPlacement !== undefined;
      }),
    ),
  ],
  ["read-adapter", setOf(supportedReadPlatforms())],
  ["reaction-feedback-ingest", setOf(registeredReactionSurfaces())],
  ["ancillary-ops", setOf(PLATFORMS.filter((p) => surfaceMessageOps(p) !== undefined))],
  ["ambient-engagement-seam", engagementSeamPlatforms()],
  ["owned-thread-ingress", ownedThreadIngressPlatforms()],
  ["engaged-row-promotion", engagedRowPromotionPlatforms()],
  ["thread-done-reaction", setOf(PLATFORMS.filter((p) => hasThreadDoneReactionPath(p)))],
  ["seat-context-admission", contextAdmissionPlatforms()],
  ["out-of-office-cover", coverWakePlatforms()],
  ["approval-card", setOf(PLATFORMS.filter((p) => hasApprovalCardPath(p)))],
  ["judge-lift-notice", setOf(PLATFORMS.filter((p) => hasJudgeLiftNoticePath(p)))],
  ["search", setOf(registeredSearchConnectors())],
]);

const declarations = new Map<string, SurfaceParityDeclaration>();
const missing: string[] = [];
for (const platform of PLATFORMS) {
  const declared = surfaceParityFor(platform);
  if (declared === undefined) missing.push(platform);
  else declarations.set(platform, declared);
}

if (missing.length > 0) {
  console.error(
    `✗ surface-parity: ${missing.join(", ")} registered no surface-parity declaration.\n` +
      `  Add \`packages/providers/<id>/agent/surface-parity.ts\` and call \`registerSurfaceParity(...)\`\n` +
      `  from that bundle's \`register<X>Provider()\`, beside \`registerCapabilityManifest\`.`,
  );
  process.exit(1);
}

const problems = checkSurfaceParity(declarations, PROBES);

console.log(renderParityMatrix(declarations, PLATFORMS));
console.log("");

if (problems.length > 0) {
  console.error(`✗ surface-parity: ${problems.length} problem(s):\n`);
  for (const p of problems) {
    console.error(`  • ${p.platform}${p.capability === undefined ? "" : ` [${p.capability}]`}: ${p.message}`);
  }
  process.exit(1);
}

{
  const unknown = SETTINGS_OVERRIDES.wake?.e2eDrivers?.filter((d) => !(PLATFORMS as readonly string[]).includes(d.surface)) ?? [];
  if (unknown.length > 0) {
    console.error(
      `✗ surface-parity: wake.e2eDrivers names ${unknown.length} surface(s) no provider bundle registers: ` +
        `${[...new Set(unknown.map((d) => d.surface))].join(", ")}.\n` +
        `  A driver entry is matched on its surface WHOLE, so such an entry admits nobody while reading as a vouch.\n` +
        `  Valid surfaces: ${PLATFORMS.join(", ")}. Fix the entry in agent/settings/settings.ts.`,
    );
    process.exit(1);
  }
}

{
  const posters = registeredPostArmPlatforms();
  const quiet = posters.filter((p) => !hasJudgeLiftNoticePath(p));
  if (quiet.length === 0) {
    console.log(`✓ surface-parity: a judge-lift notice renders on all ${posters.length} post-arm platform(s) — no room this deployment can post into stays silent on a lifted act.`);
  }
  if (quiet.length > 0) {
    console.error(
      `✗ surface-parity: ${quiet.join(", ")} register a post arm but NO judge-lift notice render.\n` +
        `  The approver chain can lower a gated verb: the frozen args execute with no approval card, and the\n` +
        `  notice is the room's only trace of an act nobody was asked about. Register a JudgeLiftNoticePoster\n` +
        `  (the button arm) or a SurfaceMessageOps transport (the shared text arm) from that bundle's\n` +
        `  register<X>Provider(), or the room stays silent.`,
    );
    process.exit(1);
  }
}

interface Region {
  readonly name: string;
  readonly group: "seam" | "shape" | "verb";
}

const REGIONS: readonly Region[] = [
  { name: "surface-parity-seams", group: "seam" },
  { name: "surface-parity-shapes", group: "shape" },
  { name: "surface-parity-verbs", group: "verb" },
];

const contractPath = resolve(root, CONTRACT);
const original = readFileSync(contractPath, "utf8");
let updated = original;

{
  const headings = new Set([...original.matchAll(/^#{1,6}\s+(\d+(?:\.\d+)*)\.?\s/gmu)].map((m) => m[1]!));
  const dangling = SURFACE_CAPABILITIES.filter((c) => !headings.has(c.section.replace(/^§/u, "")));
  if (dangling.length > 0) {
    console.error(
      `✗ surface-parity: ${dangling.length} roster row(s) point at a section ${CONTRACT} does not have:\n` +
        dangling.map((c) => `  • ${c.id} → ${c.section}`).join("\n") +
        `\n  Fix the \`section\` in packages/core/agent/identity/surface-parity.ts, or add the heading.`,
    );
    process.exit(1);
  }
}

for (const region of REGIONS) {
  const begin = `<!-- BEGIN GENERATED: ${region.name} (scripts/surface-parity.ts) -->`;
  const end = `<!-- END GENERATED: ${region.name} -->`;
  const beginAt = updated.indexOf(begin);
  const endAt = updated.indexOf(end);
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    console.error(
      `✗ surface-parity: ${CONTRACT} is missing the \`${region.name}\` markers.\n` +
        `  Expected a block delimited by:\n    ${begin}\n    ${end}\n` +
        `  Re-add them where that table should live — this script owns everything between them.`,
    );
    process.exit(1);
  }
  const table = [begin, "", renderParityTable(region.group, declarations, PLATFORMS), "", end].join("\n");
  updated = updated.slice(0, beginAt) + table + updated.slice(endAt + end.length);
}

function declarationAtoms(text: string): string {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/^[^\n"]*\/\/[^\n]*$/gmu, " ")
    .replace(/^\s*import\s[^;]*;/gmu, " ");
  const strings = [...code.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((m) => m[1]!);
  const keys = [...code.matchAll(/(?:^|[{,])\s*"?([a-z_][a-z0-9_-]*)"?\s*:/gimu)].map((m) => m[1]!);
  return [...new Set([...strings, ...keys])].sort().join("\n");
}
{
  const stale = PLATFORMS.filter((p) => {
    const src = join(root, "packages", "providers", p, "agent", "surface-parity.ts");
    const built = join(root, "packages", "providers", p, "dist", "agent", "surface-parity.js");
    try {
      return declarationAtoms(readFileSync(src, "utf8")) !== declarationAtoms(readFileSync(built, "utf8"));
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(
      `✗ surface-parity: ${stale.join(", ")} — the declaration SOURCE and its BUILD disagree, and this\n` +
        `  gate reads the build. It would render the PREVIOUS declarations: ${check ? "reporting green" : "silently reverting"}\n` +
        `  ${check ? `over a ${CONTRACT} that is stale against the source you just edited` : CONTRACT}.\n` +
        `  Run: npm run build:packages`,
    );
    process.exit(1);
  }
}

if (check) {
  if (updated !== original) {
    console.error(
      `✗ surface-parity: the generated tables in ${CONTRACT} are out of date with the provider\n` +
        `  declarations (packages/providers/*/agent/surface-parity.ts).\n` +
        `  Run: npx tsx scripts/surface-parity.ts`,
    );
    process.exit(1);
  }
  console.log(
    `✓ surface-parity: ${PLATFORMS.length} surfaces, every capability declared with a reason, ` +
      `${PROBES.size - SOURCE_SCAN_PROBES.length} row(s) cross-checked against the live registries + ` +
      `${SOURCE_SCAN_PROBES.length} (${SOURCE_SCAN_PROBES.join(", ")}) against the bundle sources, ` +
      `${CONTRACT} in sync`,
  );
} else {
  const wrote = writeFileIfChanged(contractPath, updated);
  console.log(`✓ surface-parity: ${CONTRACT} ${wrote ? "updated" : "already current"} — 3 generated table(s)`);
}
