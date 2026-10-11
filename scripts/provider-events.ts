import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileIfChanged } from "./write-if-changed.js";

import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerEmailProvider } from "@open-everywhere/provider-email/agent/register.js";
import {
  checkProviderEvents,
  clearProviderSelection,
  eventNormalizer,
  providerEventsFor,
  registeredEventSources,
  registeredProviderEventPlatforms,
  renderProviderEventInventory,
  renderProviderEventMatrix,
  type NormalizerFacts,
  type NormalizerProbe,
  type ProviderEventDeclaration,
} from "@open-everywhere/core/agent/adapter-api.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const pageFlagAt = process.argv.indexOf("--page");
const PAGE =
  pageFlagAt >= 0 && process.argv[pageFlagAt + 1] !== undefined
    ? process.argv[pageFlagAt + 1]!
    : "docs/capabilities/proactivity-and-routines.md";

if (pageFlagAt >= 0 && !check) {
  console.error("✗ provider-events: --page is a verification affordance and requires --check; it never writes.");
  process.exit(1);
}

const PROVIDERS = ["github", "linear", "notion", "slack", "discord", "teams", "email"] as const;

clearProviderSelection();

registerSlackProvider();
registerDiscordProvider();
registerTeamsProvider();
registerGithubProvider();
registerLinearProvider();
registerNotionProvider();
registerEmailProvider();

function normalizerProbe(): NormalizerProbe {
  const facts = new Map<string, NormalizerFacts>();
  for (const source of registeredEventSources()) {
    const n = eventNormalizer(source);
    if (n === undefined) continue;
    facts.set(source, { matchKeys: n.matchKeys, scopeKinds: n.scopeKinds });
  }
  return facts;
}

const declarations = new Map<string, ProviderEventDeclaration>();
const missing: string[] = [];
for (const provider of PROVIDERS) {
  const declared = providerEventsFor(provider);
  if (declared === undefined) missing.push(provider);
  else declarations.set(provider, declared);
}

if (missing.length > 0) {
  console.error(
    `✗ provider-events: ${missing.join(", ")} registered no event inventory.\n` +
      `  Add \`packages/providers/<id>/agent/provider-events.ts\` and call \`registerProviderEvents(...)\`\n` +
      `  from that bundle's \`register<X>Provider()\`, beside \`registerSurfaceParity\`.`,
  );
  process.exit(1);
}

const unrendered = registeredProviderEventPlatforms().filter((p) => !(PROVIDERS as readonly string[]).includes(p));
if (unrendered.length > 0) {
  console.error(
    `✗ provider-events: ${unrendered.join(", ")} registered an event inventory that this gate neither checks nor renders.\n` +
      `  Add each one to PROVIDERS in scripts/provider-events.ts, then re-run to generate its table.`,
  );
  process.exit(1);
}

const probe = normalizerProbe();
if (probe.size === 0) {
  console.error(
    `✗ provider-events: no event normalizer is registered, so every match-key and scope-kind check\n` +
      `  would be skipped and this gate would pass without verifying anything. Expected at least the\n` +
      `  core GitHub normalizer. Check the bundle boot above and the provider-selection gate.`,
  );
  process.exit(1);
}

const problems = checkProviderEvents(declarations, probe);

console.log(renderProviderEventMatrix(declarations, [...PROVIDERS]));
console.log("");

if (problems.length > 0) {
  console.error(`✗ provider-events: ${problems.length} problem(s):\n`);
  for (const p of problems) {
    console.error(`  • ${p.provider}${p.event === undefined ? "" : ` [${p.event}]`}: ${p.message}`);
  }
  process.exit(1);
}

const REGION = "provider-event-inventory";
const begin = `<!-- BEGIN GENERATED: ${REGION} (scripts/provider-events.ts) -->`;
const end = `<!-- END GENERATED: ${REGION} -->`;

const pagePath = resolve(root, PAGE);
const original = readFileSync(pagePath, "utf8");
const beginAt = original.indexOf(begin);
const endAt = original.indexOf(end);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  console.error(
    `✗ provider-events: ${PAGE} is missing the \`${REGION}\` markers.\n` +
      `  Expected a block delimited by:\n    ${begin}\n    ${end}\n` +
      `  Re-add them where the inventory should live — this script owns everything between them.`,
  );
  process.exit(1);
}
const block = [begin, "", renderProviderEventInventory(declarations, [...PROVIDERS]), "", end].join("\n");
const updated = original.slice(0, beginAt) + block + original.slice(endAt + end.length);

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
  const stale = PROVIDERS.filter((p) => {
    const src = join(root, "packages", "providers", p, "agent", "provider-events.ts");
    const built = join(root, "packages", "providers", p, "dist", "agent", "provider-events.js");
    try {
      return declarationAtoms(readFileSync(src, "utf8")) !== declarationAtoms(readFileSync(built, "utf8"));
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(
      `✗ provider-events: ${stale.join(", ")} — the declaration SOURCE and its BUILD disagree, and this\n` +
        `  gate reads the build. It would render the PREVIOUS declarations: ${check ? "reporting green" : "silently reverting"}\n` +
        `  ${check ? `over a ${PAGE} that is stale against the source you just edited` : PAGE}.\n` +
        `  Run: npm run build:packages`,
    );
    process.exit(1);
  }
}

if (check) {
  if (updated !== original) {
    console.error(
      `✗ provider-events: the generated inventory in ${PAGE} is out of date with the provider\n` +
        `  declarations (packages/providers/*/agent/provider-events.ts).\n` +
        `  Run: npx tsx scripts/provider-events.ts`,
    );
    process.exit(1);
  }
  const rows = [...declarations.values()].reduce((n, d) => n + d.events.length, 0);
  console.log(
    `✓ provider-events: ${PROVIDERS.length} providers, ${rows} declared vendor events, every row noted and cited, ` +
      `every match key and scope kind cross-checked against the live normalizer registry ` +
      `(${[...probe.keys()].sort().join(", ")}), ${PAGE} in sync`,
  );
} else {
  const wrote = writeFileIfChanged(pagePath, updated);
  console.log(`✓ provider-events: ${PAGE} ${wrote ? "updated" : "already current"} — 1 generated inventory`);
}
