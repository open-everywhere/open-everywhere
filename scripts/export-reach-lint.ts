import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codeOnly } from "./ambient-env-manifest.js";
import { PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SURFACE_FILES: ReadonlySet<string> = new Set(["index.ts", "adapter-api.ts", "contributions.ts"]);

export const KNOWN_UNREACHED_EXPORTS: ReadonlySet<string> = new Set([
  "packages/adapters/agent/aws/sso.ts::OE_AWS_SSO_CALLBACK_PATH",
  "packages/adapters/agent/oe-oauth/errors.ts::subjectLabel",
  "packages/adapters/agent/postgres/neon.ts::configureLocalWsProxy",
  "packages/core/agent/access/approver-chain.ts::chainTaintKinds",
  "packages/core/agent/access/approver-chain.ts::chainTaintSignal",
  "packages/core/agent/access/aws-screen.ts::AWS_S3_HIGH_LEVEL_FANOUT",
  "packages/core/agent/access/consequence.ts::NON_TOOL_APPROVAL_SITES",
  "packages/core/agent/access/consequence.ts::POST_TURN_WRITE_PRIMITIVES",
  "packages/core/agent/access/credential-bindings-codemod.ts::registerOverlayHome",
  "packages/core/agent/access/group-request.ts::buildResolveRequestWithGroups",
  "packages/core/agent/access/permission-proposal.ts::PERMISSION_CONFIG_FILE",
  "packages/core/agent/access/window-gated.ts::WINDOW_UNGATED_TOOLS",
  "packages/core/agent/access/window-gated.ts::checkWindowGateManifest",
  "packages/core/agent/blob/hosting.ts::assertBlobHostingValid",
  "packages/core/agent/channels/channel-read.ts::ChannelScopeError",
  "packages/core/agent/channels/context-render.ts::MAX_CHARS",
  "packages/core/agent/channels/context-render.ts::capLines",
  "packages/core/agent/channels/generation-retirement.ts::RETIREMENT_CONFIRM_TIMEOUT_MS",
  "packages/core/agent/channels/self-dispatch.ts::SELF_DISPATCH_ATTEMPTS",
  "packages/core/agent/channels/self-dispatch.ts::SELF_DISPATCH_TIMEOUT_MS",
  "packages/core/agent/connections/connector-auth.ts::appConnectToken",
  "packages/core/agent/connections/connector-auth.ts::appStaticToken",
  "packages/core/agent/connections/connector-auth.ts::userInteractiveOAuth",
  "packages/core/agent/control/auth.ts::INJECT_TOKEN_ENV",
  "packages/core/agent/control/http.ts::handleControlRequest",
  "packages/core/agent/credentials/reserved-refs.ts::RESERVED_REF_NAMESPACES",
  "packages/core/agent/docs/source-map.ts::UNIVERSAL_SURFACE_DOCS",
  "packages/core/agent/hooks/link-claim.ts::claimBodyOf",
  "packages/core/agent/identity/principals.ts::accountRefKey",
  "packages/core/agent/instructions/access.ts::renderRecoveryReadDoctrine",
  "packages/core/agent/memory/dream/mode3.ts::FAILURE_ACTIONS",
  "packages/core/agent/memory/dream/ops.ts::DESTRUCTIVE_KINDS",
  "packages/core/agent/memory/sync-timing.ts::MemorySyncTimingCollector",
  "packages/core/agent/model/call-capture.ts::CAPTURE_MAX_BODY_B64_BYTES",
  "packages/core/agent/model/policy.ts::REASONING_ORDER",
  "packages/core/agent/observability/telemetry.ts::RESOURCE_ATTR_KEYS",
  "packages/core/agent/observability/telemetry.ts::buildOtlpPayload",
  "packages/core/agent/plugins/extract.ts::renderGeneratedSkillModule",
  "packages/core/agent/routines/fire-carriage.ts::FIRE_ATTRS_SENT_ACTION",
  "packages/core/agent/routines/github-fanout.ts::DELIVERY_DEDUPE_TTL_MS",
  "packages/core/agent/routines/match-stamp.ts::MATCH_STAMP_WINDOW_MS",
  "packages/core/agent/scm/repo-skills.ts::repoSkillsState",
  "packages/core/agent/stall/guard.ts::reduceResult",
  "packages/core/agent/tools/request_credential_grant.ts::requestCredentialGrantMount",
  "packages/core/agent/tools/set_dm_delivery.ts::isOneToOneDm",
  "packages/providers/github/agent/channels/github-reaction-scope.ts::GITHUB_REACTION_POLL_HOURLY_BUDGET",
  "packages/providers/linear/agent/channels/linear-graphql.ts::LINEAR_SURFACE",
  "packages/providers/notion/agent/channels/notion-api.ts::BLOCK_PARENT_MAX_HOPS",
  "packages/providers/notion/agent/channels/notion-api.ts::NOTION_API_BASE",
  "packages/providers/notion/agent/channels/notion-api.ts::retrieveBlock",
  "packages/providers/notion/agent/channels/notion-api.ts::retrievePage",
  "packages/providers/notion/agent/channels/notion-supervisor.ts::notionExternalAuthorDecision",
  "packages/providers/slack/agent/channels/slack-context.ts::renderContext",
  "packages/providers/slack/agent/channels/slack-events.ts::PREFER_NO_REPLY_TOOL",
  "packages/providers/slack/agent/channels/slack-events.ts::_engagementWakeMode",
  "packages/providers/slack/agent/channels/slack-events.ts::_resetBotDisplayName",
  "packages/providers/slack/agent/channels/slack-events.ts::nameDropAbstained",
  "packages/providers/slack/agent/channels/slack-events.ts::slackDmWake",
  "packages/providers/slack/agent/channels/slack-events.ts::slackGovernanceRoster",
  "packages/providers/slack/agent/channels/slack-events.ts::slackWakeSpendGate",
  "packages/providers/slack/agent/channels/slack-events.ts::withholdNameDropContext",
  "packages/providers/slack/agent/channels/slack-front.ts::_resetBotIdentity",
  "packages/providers/slack/agent/channels/slack-front.ts::_resetDmTrustCache",
  "packages/providers/slack/agent/channels/slack-front.ts::deliverWithStrandRetry",
  "packages/providers/slack/agent/channels/slack-front.ts::resolveBotIdentity",
  "packages/providers/slack/agent/channels/slack-identity.ts::slackWorkspaceVouched",
  "packages/providers/slack/agent/channels/slack-wake-backscroll.ts::_resetWakeBotIdentity",
  "packages/providers/teams/agent/channels/teams-conversation-ref.ts::TEAMS_TEAM_ADDRESS_READ_LIMIT",
  "packages/providers/teams/agent/channels/teams-front.ts::liveTeamsFrontPlan",
  "packages/providers/teams/agent/channels/teams-graph-boundary.ts::TEAMS_READ_BOUNDARY_SOURCES",
]);

const EXPORT_REACH_REMEDY =
  "Fix: delete the `export` keyword — the name keeps working inside its own file. If the export is\n" +
  "  a real contract, import it from the file that needs it in the same change. If it is a public\n" +
  "  surface, re-export it from the package's `adapter-api.ts` (or `index.ts`).";

export interface ImportSite {
  readonly spec: string;
  readonly names: readonly string[];
  readonly whole: boolean;
}

export interface AuditOptions {
  readonly baseline?: ReadonlySet<string>;
}

export interface ReachVerdict {
  readonly reds: readonly string[];
  readonly scanned: number;
  readonly ruledOn: number;
  readonly wholesaleSkipped: number;
  readonly exports: number;
  readonly importers: number;
  readonly typesSkipped: number;
  readonly carried: number;
}

const KEYWORD = /\b(import|export)\b/g;
const SPEC_AFTER_FROM = /(?<![.\w$])from\s*(["'])[^"'\n]*\1/;
const SPEC_DIRECT = /^\s*(["'])[^"'\n]*\1/;
const STATEMENT_WINDOW = 4000;
const CLAUSE = /^\s*(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^{}]*\}|[A-Za-z_$][\w$]*)\s*$/;

function specAt(raw: string, masked: string, start: number, end: number): string | null {
  const quoted = /(["'])[^"'\n]*\1/.exec(masked.slice(start, end));
  if (!quoted) return null;
  const open = start + quoted.index;
  return raw.slice(open + 1, open + quoted[0].length - 1);
}

function bindingNames(clause: string): string[] {
  const braced = /\{([^}]*)\}/.exec(clause);
  if (!braced) return [];
  const names: string[] = [];
  for (const part of braced[1]!.split(",")) {
    const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
  }
  return names;
}

const AWAIT_LOOKBACK = 400;
const DESTRUCTURED_AWAIT = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?$/;

function destructuredNames(masked: string, keywordAt: number): string[] {
  const back = masked.slice(Math.max(0, keywordAt - AWAIT_LOOKBACK), keywordAt);
  const bound = DESTRUCTURED_AWAIT.exec(back);
  return bound ? bindingNames(`{${bound[1]!}}`) : [];
}

export function importSitesIn(source: string): ImportSite[] {
  const masked = codeOnly(source);
  const sites: ImportSite[] = [];
  KEYWORD.lastIndex = 0;
  for (let m = KEYWORD.exec(masked); m !== null; m = KEYWORD.exec(masked)) {
    const after = m.index + m[0]!.length;
    const window = masked.slice(after, after + STATEMENT_WINDOW);
    const semi = window.indexOf(";");
    const body = semi === -1 ? window : window.slice(0, semi);

    if (m[1] === "import") {
      const dyn = /^\s*\(\s*(["'])[^"'\n]*\1/.exec(body);
      if (dyn) {
        const spec = specAt(source, masked, after, after + dyn[0].length);
        if (spec) {
          const names = destructuredNames(masked, m.index);
          sites.push({ spec, names, whole: names.length === 0 });
        }
        continue;
      }
      const bare = SPEC_DIRECT.exec(body);
      if (bare) {
        const spec = specAt(source, masked, after, after + bare[0].length);
        if (spec) sites.push({ spec, names: [], whole: true });
        continue;
      }
    }

    const from = SPEC_AFTER_FROM.exec(body);
    if (!from) continue;
    const clause = body.slice(0, from.index);
    if (!CLAUSE.test(clause)) continue;
    const spec = specAt(source, masked, after + from.index, after + from.index + from[0].length);
    if (!spec) continue;
    sites.push({ spec, names: bindingNames(clause), whole: clause.includes("*") });
  }
  return sites;
}

const DECLARED = /(?:^|[;{}\n])[ \t]*export[ \t]+(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(function[ \t]*\*?|const|let|var|class|interface|enum|type)[ \t]+([A-Za-z_$][\w$]*)/g;
const LISTED = /(?:^|[;{}\n])[ \t]*export[ \t]+(type[ \t]+)?\{([^}]*)\}/g;

export type ExportKind = "value" | "type";

export interface ExportedName {
  readonly name: string;
  readonly kind: ExportKind;
}

export function exportedNamesIn(source: string): ExportedName[] {
  return exportedNamesFromMask(codeOnly(source));
}

function exportedNamesFromMask(masked: string): ExportedName[] {
  const kinds = new Map<string, ExportKind>();
  const add = (name: string, kind: ExportKind): void => {
    if (kind === "value" || !kinds.has(name)) kinds.set(name, kind);
  };
  DECLARED.lastIndex = 0;
  for (let m = DECLARED.exec(masked); m !== null; m = DECLARED.exec(masked)) {
    add(m[2]!, m[1] === "type" || m[1] === "interface" ? "type" : "value");
  }
  LISTED.lastIndex = 0;
  for (let m = LISTED.exec(masked); m !== null; m = LISTED.exec(masked)) {
    const listIsType = m[1] !== undefined;
    for (const part of m[2]!.split(",")) {
      const trimmed = part.trim();
      const entryIsType = /^type\s+/.test(trimmed);
      const halves = trimmed.replace(/^type\s+/, "").split(/\s+as\s+/);
      const name = (halves[1] ?? halves[0])?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) add(name, listIsType || entryIsType ? "type" : "value");
    }
  }
  return [...kinds].map(([name, kind]) => ({ name, kind })).sort((a, b) => a.name.localeCompare(b.name));
}

export function reexportsStar(source: string): boolean {
  return reexportsStarFromMask(codeOnly(source));
}

function reexportsStarFromMask(masked: string): boolean {
  return /(?:^|[;{}\n])[ \t]*export[ \t]*\*/.test(masked);
}

const EXPORT_ANCHOR = /(?:^|[;{}\n])[ \t]*export\b/g;
const READABLE_OPENING =
  /^\s*(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\s*\*?|const|let|var|class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/;

export function unreadableExportsIn(source: string): string[] {
  return unreadableExportsFromMask(codeOnly(source));
}

function unreadableExportsFromMask(masked: string): string[] {
  const bad: string[] = [];
  EXPORT_ANCHOR.lastIndex = 0;
  for (let m = EXPORT_ANCHOR.exec(masked); m !== null; m = EXPORT_ANCHOR.exec(masked)) {
    const rest = masked.slice(m.index + m[0]!.length, m.index + m[0]!.length + STATEMENT_WINDOW);
    if (/^\s*(?:default\b|\*)/.test(rest)) continue;
    if (/^\s*(?:type\s+)?\{/.test(rest)) continue;
    const opening = READABLE_OPENING.exec(rest);
    if (!opening) {
      bad.push(`\`export ${rest.trim().slice(0, 40).split("\n")[0]!}…\` — an export form this scanner cannot enumerate`);
      continue;
    }
    const keyword = opening[1]!;
    if (keyword !== "const" && keyword !== "let" && keyword !== "var") continue;
    if (hasSecondDeclarator(rest.slice(opening[0].length))) {
      bad.push(`\`export ${keyword} ${opening[2]!}, …\` — more than one declarator; only the first is read`);
    }
  }
  return bad;
}

function hasSecondDeclarator(rest: string): boolean {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === ";") return false;
    else if (depth === 0 && c === ",") {
      if (/^\s*[A-Za-z_$][\w$]*\s*[:=,;]/.test(rest.slice(i + 1))) return true;
    }
  }
  return false;
}

function walkSources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      walkSources(path, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

export function isGenerated(file: string): boolean {
  const base = basename(file);
  return (
    file.split(sep).includes("generated") ||
    base.endsWith(".generated.ts") ||
    base === "docs-generated.ts"
  );
}

export function isSurface(file: string): boolean {
  return SURFACE_FILES.has(basename(file));
}

function workspaceDirs(root: string): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const rel of PUBLISHABLE_PACKAGES) {
    const manifest = join(root, rel, "package.json");
    if (!existsSync(manifest)) continue;
    const name: unknown = JSON.parse(readFileSync(manifest, "utf8")).name;
    if (typeof name === "string") dirs.set(name, join(root, rel));
  }
  return dirs;
}

function makeResolver(root: string): (from: string, spec: string) => string | null {
  const packages = workspaceDirs(root);
  const cache = new Map<string, string | null>();
  return (from, spec) => {
    let base: string;
    if (spec.startsWith(".")) {
      base = resolve(dirname(from), spec);
    } else {
      let longest: string | null = null;
      for (const name of packages.keys()) {
        if ((spec === name || spec.startsWith(`${name}/`)) && (longest === null || name.length > longest.length)) {
          longest = name;
        }
      }
      if (longest === null) return null;
      base = join(packages.get(longest)!, spec.slice(longest.length));
    }
    const hit = cache.get(base);
    if (hit !== undefined) return hit;
    const stem = base.replace(/\.js$/, "");
    let found: string | null = null;
    for (const candidate of [`${stem}.ts`, `${base}.ts`, join(stem, "index.ts"), join(base, "index.ts")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        found = candidate;
        break;
      }
    }
    cache.set(base, found);
    return found;
  };
}

function importerRoots(root: string): string[] {
  const roots = ["agent", "scripts", "tests", "deploy"].map((d) => join(root, d));
  for (const rel of [...PUBLISHABLE_PACKAGES, "packages/create"]) {
    for (const sub of ["agent", "scripts", "src", "bin"]) roots.push(join(root, rel, sub));
  }
  roots.push(join(root, "packages/core/templates"));
  return roots;
}

function importerFiles(root: string): string[] {
  const loose = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts"))
        .map((e) => join(root, e.name))
    : [];
  return [...new Set([...importerRoots(root).flatMap((dir) => walkSources(dir)), ...loose])];
}

function scannedModules(root: string): string[] {
  return PUBLISHABLE_PACKAGES.flatMap((rel) => walkSources(join(root, rel, "agent"))).filter(
    (file) => !isSurface(file) && !isGenerated(file),
  );
}

export function staleBaselineEntries(baseline: ReadonlySet<string>, stillOwed: ReadonlySet<string>): string[] {
  const stale: string[] = [];
  for (const key of baseline) {
    if (!stillOwed.has(key)) {
      stale.push(`${key} — fixed, or gone: delete this line from KNOWN_UNREACHED_EXPORTS (the list may only shrink)`);
    }
  }
  return stale;
}

export function auditExportReach(root: string, options: AuditOptions = {}): ReachVerdict {
  const baseline = options.baseline ?? KNOWN_UNREACHED_EXPORTS;
  const checkStale = options.baseline !== undefined || resolve(root) === REPO_ROOT;
  const resolveSpec = makeResolver(root);
  const importers = importerFiles(root);

  const taken = new Map<string, Set<string>>();
  const wholesale = new Set<string>();

  for (const file of importers) {
    for (const site of importSitesIn(readFileSync(file, "utf8"))) {
      const target = resolveSpec(file, site.spec);
      if (target === null || target === file) continue;
      if (site.whole) wholesale.add(target);
      if (site.names.length === 0) continue;
      let names = taken.get(target);
      if (names === undefined) taken.set(target, (names = new Set()));
      for (const name of site.names) names.add(name);
    }
  }

  const reds: string[] = [];
  const modules = scannedModules(root);
  const stillOwed = new Set<string>();
  const keepBaselineFor = (shown: string): void => {
    for (const key of baseline) if (key.startsWith(`${shown}::`)) stillOwed.add(key);
  };
  let exports = 0;
  let typesSkipped = 0;
  let carried = 0;
  let ruledOn = 0;
  let wholesaleSkipped = 0;
  for (const file of modules) {
    const masked = codeOnly(readFileSync(file, "utf8"));
    const shown = relative(root, file);
    if (reexportsStarFromMask(masked)) {
      reds.push(`${shown}: \`export *\` — its export set cannot be enumerated, so reach cannot be proven`);
      keepBaselineFor(shown);
      continue;
    }
    for (const why of unreadableExportsFromMask(masked)) reds.push(`${shown}: ${why}`);
    if (wholesale.has(file)) {
      wholesaleSkipped++;
      keepBaselineFor(shown);
      continue;
    }
    ruledOn++;
    const reached = taken.get(file);
    for (const { name, kind } of exportedNamesFromMask(masked)) {
      if (kind === "type") {
        if (reached?.has(name) !== true) typesSkipped++;
        continue;
      }
      exports++;
      if (reached?.has(name) === true) continue;
      const key = `${shown}::${name}`;
      if (baseline.has(key)) {
        stillOwed.add(key);
        carried++;
        continue;
      }
      reds.push(`${shown}: \`${name}\` is exported and no other file imports it`);
    }
  }

  if (checkStale) reds.push(...staleBaselineEntries(baseline, stillOwed));

  return {
    reds,
    scanned: modules.length,
    ruledOn,
    wholesaleSkipped,
    exports,
    importers: importers.length,
    typesSkipped,
    carried,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const rootAt = argv.indexOf("--root");
  if (rootAt !== -1 && argv[rootAt + 1] === undefined) {
    console.error("✗ export-reach: --root needs a directory.");
    process.exit(1);
  }
  const root = rootAt === -1 ? REPO_ROOT : resolve(process.cwd(), argv[rootAt + 1]!);
  const verdict = auditExportReach(root);

  if (argv.includes("--list")) for (const red of verdict.reds) console.log(`  ${red}`);

  if (verdict.reds.length > 0) {
    console.error(
      `✗ export-reach: ${verdict.reds.length} export(s) with no importer outside their own file, ` +
        `across ${verdict.scanned} module(s):\n`,
    );
    for (const red of verdict.reds) console.error(`  • ${red}`);
    console.error(`\n${EXPORT_REACH_REMEDY}`);
    process.exit(1);
  }

  console.log(
    `✓ export-reach: ${verdict.exports} value export(s) across the ${verdict.ruledOn} module(s) the rule ` +
      `reached — every one has an importer outside its own file, or is one of the ${verdict.carried} the ` +
      `baseline still carries (must only shrink).\n` +
      `  Of ${verdict.scanned} module(s) in scope, ${verdict.wholesaleSkipped} were NOT ruled on: another ` +
      `file takes them wholesale (a namespace or side-effect import, or a dynamic import that does not ` +
      `name its bindings). ${verdict.importers} source file(s) scanned for importers; ` +
      `${verdict.typesSkipped} unreached type export(s) passed over by the values-only rule.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
