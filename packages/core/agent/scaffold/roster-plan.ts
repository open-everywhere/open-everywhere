import {
  CONTRIBUTION_KINDS,
  ROSTER_GENERATOR_VERSION,
  SLOT_DIR,
  type Contribution,
  type ContributionKind,
  type ContributionManifest,
  type LockedDecision,
  type RosterConfig,
  type RosterLock,
  type RosterPackageConfig,
  type RosterPackageDecision,
} from "./roster-config.js";
import { PRIMITIVE_DISABLED, PRIMITIVE_MOUNTED } from "./tool-roster.js";

const SLUG_PATTERN: Readonly<Record<ContributionKind, RegExp>> = {
  tool: /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u,
  channel: /^(\.?[a-z][a-z0-9-]{0,63}|\[[a-zA-Z][a-zA-Z0-9_]{0,63}\])$/u,
  hook: /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u,
  schedule: /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u,
  skill: /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u,
  connection: /^[a-z][a-z0-9-]{0,63}$/u,
};

export interface DeclaredPackage {
  readonly declaredAs: string;
  readonly name: string;
  readonly providerId?: string;
  readonly decision: RosterPackageDecision;
}

export interface ResolvedPackage extends DeclaredPackage {
  readonly resolvedName?: string;
  readonly version?: string;
  readonly manifest?: unknown;
  readonly error?: string;
}

export interface PlanInput {
  readonly config: RosterConfig;
  readonly lock: unknown;
  readonly acceptLock?: boolean;
  readonly packages: readonly ResolvedPackage[];
  readonly frameworkToolNames?: readonly string[];
  readonly agentDir: string;
}

export interface PlanFile {
  readonly path: string;
  readonly content: string;
}

export interface ResolvedContribution {
  readonly package: string;
  readonly kind: ContributionKind;
  readonly name: string;
  readonly module: string;
  readonly summary?: string;
  readonly decision: LockedDecision;
  readonly reason?: string;
  readonly note?: string;
}

export interface UnreviewedContribution {
  readonly package: string;
  readonly kind: ContributionKind;
  readonly name: string;
  readonly module: string;
  readonly summary?: string;
  readonly since?: string;
}

export interface VanishedContribution {
  readonly package: string;
  readonly kind: string;
  readonly name: string;
  readonly lockedDecision: LockedDecision;
}

export type RosterVerdict = "clean" | "unreviewed" | "vanished" | "drifted" | "invalid";

export interface PlanResult {
  readonly verdict: RosterVerdict;
  readonly reds: readonly string[];
  readonly files: readonly PlanFile[];
  readonly lock: RosterLock;
  readonly resolved: readonly ResolvedContribution[];
  readonly unreviewed: readonly UnreviewedContribution[];
  readonly vanished: readonly VanishedContribution[];
  readonly frameworkDisabled: Readonly<Record<string, string>>;
  readonly selectedProviders: readonly string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function wrapComment(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.trim().split(/\s+/u).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export const contributionKey = (kind: string, name: string): string => `${kind}/${name}`;

function sortedRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) out[key] = record[key]!;
  return out;
}

const CONFIG_KEYS = new Set(["framework", "core", "adapters", "providers", "packages", "subagents", "output"]);

export interface ParsedConfig {
  readonly config?: RosterConfig;
  readonly reds: readonly string[];
}

function checkDecision(where: string, value: unknown, reds: string[]): void {
  if (typeof value === "boolean") return;
  if (!isRecord(value)) {
    reds.push(`CONFIG · ${where} must be true, false, or an object of { exclude, note, about } — got ${typeof value}.`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "exclude" && key !== "note" && key !== "about") {
      reds.push(`CONFIG · ${where}.${key} is not a known key. Expected one of: exclude, note, about.`);
    }
  }
  if (value.about !== undefined && typeof value.about !== "string") {
    reds.push(`CONFIG · ${where}.about must be a string.`);
  }
  for (const field of ["exclude", "note"] as const) {
    const map = value[field];
    if (map === undefined) continue;
    if (!isRecord(map)) {
      reds.push(`CONFIG · ${where}.${field} must be an object mapping a contribution key to a string.`);
      continue;
    }
    for (const [key, reason] of Object.entries(map)) {
      if (typeof reason !== "string") {
        reds.push(`CONFIG · ${where}.${field}["${key}"] must be a string.`);
        continue;
      }
      if (field === "exclude" && reason.trim().length === 0) {
        reds.push(
          `CONFIG · ${where}.exclude["${key}"] has an empty reason. Every exclusion carries WHY this ` +
            `deployment declines the capability — that text is the review surface.`,
        );
      }
    }
  }
}

export function parseRosterConfig(raw: unknown): ParsedConfig {
  const reds: string[] = [];
  if (!isRecord(raw)) {
    return { reds: [`CONFIG · roster.config.ts must \`export default defineRoster({ … })\` — got ${raw === undefined ? "no default export" : typeof raw}.`] };
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      reds.push(`CONFIG · unknown top-level key "${key}". Expected one of: ${[...CONFIG_KEYS].sort().join(", ")}.`);
    }
  }
  if (raw.framework !== undefined) {
    if (!isRecord(raw.framework)) reds.push(`CONFIG · framework must be an object with a \`disable\` map.`);
    else {
      for (const key of Object.keys(raw.framework)) {
        if (key !== "disable") reds.push(`CONFIG · framework.${key} is not a known key. Expected: disable.`);
      }
      const disable = raw.framework.disable;
      if (disable !== undefined) {
        if (!isRecord(disable)) reds.push(`CONFIG · framework.disable must be an object mapping an eve tool name to a reason.`);
        else {
          for (const [name, reason] of Object.entries(disable)) {
            if (typeof reason !== "string" || reason.trim().length === 0) {
              reds.push(
                `CONFIG · framework.disable["${name}"] has no reason. A sentinel takes a built-in AWAY; ` +
                  `the reason is what stops a later reader deleting it by accident.`,
              );
            }
          }
        }
      }
    }
  }
  for (const key of ["core", "adapters"] as const) {
    if (raw[key] !== undefined) checkDecision(key, raw[key], reds);
  }
  for (const group of ["providers", "packages"] as const) {
    const value = raw[group];
    if (value === undefined) continue;
    if (!isRecord(value)) {
      reds.push(`CONFIG · ${group} must be an object keyed by ${group === "providers" ? "provider id" : "npm package name"}.`);
      continue;
    }
    for (const [id, decision] of Object.entries(value)) checkDecision(`${group}.${id}`, decision, reds);
  }
  if (raw.output !== undefined) {
    if (!isRecord(raw.output)) reds.push(`CONFIG · output must be an object.`);
    else if (raw.output.agentDir !== undefined && typeof raw.output.agentDir !== "string") {
      reds.push(`CONFIG · output.agentDir must be a string.`);
    }
  }
  if (reds.length > 0) return { reds };
  return { config: raw as RosterConfig, reds };
}

export function declaredPackages(config: RosterConfig): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  if (config.core !== undefined) out.push({ declaredAs: "core", name: "@open-everywhere/core", decision: config.core });
  if (config.adapters !== undefined) {
    out.push({ declaredAs: "adapters", name: "@open-everywhere/adapters", decision: config.adapters });
  }
  for (const [id, decision] of Object.entries(config.providers ?? {})) {
    out.push({ declaredAs: `providers.${id}`, name: `@open-everywhere/provider-${id}`, providerId: id, decision });
  }
  for (const [name, decision] of Object.entries(config.packages ?? {})) {
    out.push({ declaredAs: `packages["${name}"]`, name, decision });
  }
  return out;
}

export function parseContributionManifest(raw: unknown, pkg: string): { manifest?: ContributionManifest; reds: string[] } {
  const reds: string[] = [];
  const where = `MANIFEST · ${pkg}/agent/contributions.ts`;
  if (!isRecord(raw)) return { reds: [`${where} must export CONTRIBUTIONS as an object.`] };
  if (raw.schemaVersion !== 1) reds.push(`${where} has schemaVersion ${String(raw.schemaVersion)}; this build understands 1.`);
  if (typeof raw.package !== "string" || raw.package.length === 0) reds.push(`${where} must declare its own npm \`package\` name.`);
  if (raw.register !== undefined && (typeof raw.register !== "string" || !raw.register.includes("#"))) {
    reds.push(`${where} \`register\` must be "<module>#<exportName>", e.g. "agent/register.js#registerSlackProvider".`);
  }
  if (!Array.isArray(raw.contributions)) {
    reds.push(`${where} must declare a \`contributions\` array.`);
    return { reds };
  }
  const seen = new Set<string>();
  for (const [index, entry] of raw.contributions.entries()) {
    const at = `${where} contributions[${index}]`;
    if (!isRecord(entry)) {
      reds.push(`${at} must be an object.`);
      continue;
    }
    if (typeof entry.kind !== "string" || !CONTRIBUTION_KINDS.includes(entry.kind as ContributionKind)) {
      reds.push(`${at} has kind "${String(entry.kind)}"; expected one of ${CONTRIBUTION_KINDS.join(", ")}.`);
      continue;
    }
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      reds.push(`${at} must have a non-empty \`name\` (it is BOTH the filename and the mounted name).`);
      continue;
    }
    if (typeof entry.module !== "string" || !entry.module.endsWith(".js")) {
      reds.push(`${at} (${entry.name}) must have a \`module\` sub-path ending in ".js" (ESM), e.g. "agent/tools/${entry.name}.js".`);
      continue;
    }
    for (const optional of ["summary", "since"] as const) {
      if (entry[optional] !== undefined && typeof entry[optional] !== "string") {
        reds.push(`${at} (${entry.name}) \`${optional}\` must be a string.`);
      }
    }
    const key = contributionKey(entry.kind, entry.name);
    if (seen.has(key)) reds.push(`${at} duplicates "${key}" — a package may contribute a (kind, name) pair once.`);
    seen.add(key);
  }
  if (reds.length > 0) return { reds };
  return { manifest: raw as unknown as ContributionManifest, reds };
}

const HEADER = "// GENERATED by `oe build` from roster.config.ts — DO NOT EDIT.";
const WRAP = 100;

export function renderMountedShim(specifier: string, note?: string): string {
  const lines = [HEADER];
  if (note !== undefined && note.trim().length > 0) {
    for (const line of wrapComment(note, WRAP - 3)) lines.push(line.length === 0 ? "//" : `// ${line}`);
  }
  lines.push(`export { default } from "${specifier}";`);
  return `${lines.join("\n")}\n`;
}

export function renderFrameworkSentinel(name: string, reason: string): string {
  const lines = [HEADER, `// ${name} — DECLINED as a static tool:`];
  for (const line of wrapComment(reason, WRAP - 3)) lines.push(line.length === 0 ? "//" : `// ${line}`);
  lines.push(
    "// A sentinel is how the roster records a REFUSAL — eve keeps a built-in unless a slot file takes",
    "// it away. To change this, edit `framework.disable` in roster.config.ts, then `oe build`.",
    'import { disableTool } from "eve/tools";',
    "",
    "export default disableTool();",
  );
  return `${lines.join("\n")}\n`;
}

function renderProvidersModule(
  providers: readonly { readonly id: string; readonly pkg: string; readonly module: string; readonly exportName: string; readonly about?: string }[],
): string {
  const lines = [
    HEADER,
    "//",
    "// THE PROVIDER SELECTION MANIFEST — this deployment's declaration of which provider bundles it",
    "// carries. It is DERIVED: every row is a `providers` entry in roster.config.ts whose decision is",
    "// not `false`, and the four artefacts that used to have to move together (row, app-tree stubs,",
    "// dependency, bundle dir) are now one edit — the stubs and this table are both build output.",
    "//",
    "// This is the app tree, so vendor names are allowed here — and ONLY here. Core never names a",
    "// provider: `agent/lib/register-adapters.ts` hands these ids to `declareProviderSelection()` as",
    "// opaque strings, and every platform-keyed registration seam in core then REFUSES a provider that",
    "// is not on this list (packages/core/agent/access/provider-selection.ts).",
    "//",
    "// 🔴 STATIC imports on purpose: eve bundles the agent definition and its whole import graph into",
    "// one rolldown chunk, and a literal dynamic `import()` code-splits into a second chunk and trips",
    "// eve's \"expected one authored module\" invariant.",
    "",
  ];
  for (const p of providers) lines.push(`import { ${p.exportName} } from "${p.pkg}/${p.module}";`);
  lines.push(
    "",
    "/** One selected provider bundle: its id (the `@open-everywhere/provider-<id>` suffix, and the",
    " *  `platform` string every core registry keys on) and the ONE boot call that registers it. */",
    "export interface SelectedProvider {",
    "  readonly id: string;",
    "  /** The bundle's single registration entry — see docs/extending/provider-bundles.md § anatomy. */",
    "  readonly register: () => void;",
    "}",
    "",
    "/** THE table. Order is irrelevant — each row is an independent registry write. */",
    "export const SELECTED_PROVIDERS: readonly SelectedProvider[] = [",
  );
  for (const p of providers) {
    if (p.about !== undefined && p.about.trim().length > 0) {
      for (const line of wrapComment(p.about, WRAP - 5)) lines.push(line.length === 0 ? "  //" : `  // ${line}`);
    }
    lines.push(`  { id: ${JSON.stringify(p.id)}, register: ${p.exportName} },`);
  }
  lines.push(
    "];",
    "",
    "/** The selected ids, for `declareProviderSelection()`. */",
    "export const SELECTED_PROVIDER_IDS: readonly string[] = SELECTED_PROVIDERS.map((p) => p.id);",
  );
  return `${lines.join("\n")}\n`;
}

interface PackageIndex {
  readonly pkg: ResolvedPackage;
  readonly manifest: ContributionManifest;
  readonly byQualified: Map<string, Contribution>;
  readonly byBare: Map<string, Contribution[]>;
}

function decisionConfig(decision: RosterPackageDecision): RosterPackageConfig {
  return typeof decision === "boolean" ? {} : decision;
}

function lookupKey(index: PackageIndex, key: string): { hit?: Contribution; red?: string } {
  if (key.includes("/")) {
    const hit = index.byQualified.get(key);
    return hit === undefined
      ? { red: `names "${key}", which ${index.manifest.package} does not contribute.` }
      : { hit };
  }
  const candidates = index.byBare.get(key) ?? [];
  if (candidates.length === 0) return { red: `names "${key}", which ${index.manifest.package} does not contribute.` };
  if (candidates.length > 1) {
    return {
      red:
        `names "${key}", which ${index.manifest.package} contributes in ${candidates.length} kinds ` +
        `(${candidates.map((c) => c.kind).sort().join(", ")}). Qualify it as "<kind>/${key}".`,
    };
  }
  return { hit: candidates[0]! };
}

export function planRoster(input: PlanInput): PlanResult {
  const reds: string[] = [];
  const { config, agentDir } = input;

  const indexes: PackageIndex[] = [];
  for (const pkg of input.packages) {
    if (pkg.decision === false) continue;
    if (pkg.error !== undefined || pkg.manifest === undefined) {
      reds.push(
        `PACKAGE · roster.config.ts declares \`${pkg.declaredAs}\` but ${pkg.name} could not be resolved ` +
          `(${pkg.error ?? "no contributions manifest"}). Fix: \`npm i ${pkg.name}\`, or set \`${pkg.declaredAs}: false\`.`,
      );
      continue;
    }
    if (pkg.resolvedName !== undefined && pkg.resolvedName !== pkg.name) {
      reds.push(`PACKAGE · \`${pkg.declaredAs}\` resolved to package.json name "${pkg.resolvedName}", not "${pkg.name}".`);
      continue;
    }
    if (pkg.version === undefined) {
      reds.push(`PACKAGE · \`${pkg.declaredAs}\` (${pkg.name}) resolved with no \`version\` field in its package.json — the lock cannot record one.`);
      continue;
    }
    const parsed = parseContributionManifest(pkg.manifest, pkg.name);
    if (parsed.manifest === undefined) {
      reds.push(...parsed.reds);
      continue;
    }
    if (parsed.manifest.package !== pkg.name) {
      reds.push(
        `MANIFEST · ${pkg.name}/agent/contributions.ts declares package "${parsed.manifest.package}" but was ` +
          `resolved through "${pkg.name}". A manifest that misnames its own package cannot be attributed.`,
      );
      continue;
    }
    const byQualified = new Map<string, Contribution>();
    const byBare = new Map<string, Contribution[]>();
    for (const c of parsed.manifest.contributions) {
      byQualified.set(contributionKey(c.kind, c.name), c);
      byBare.set(c.name, [...(byBare.get(c.name) ?? []), c]);
    }
    indexes.push({ pkg, manifest: parsed.manifest, byQualified, byBare });
  }

  const resolved: ResolvedContribution[] = [];
  for (const index of indexes) {
    const cfg = decisionConfig(index.pkg.decision);
    const excludeOf = new Map<string, string>();
    const noteOf = new Map<string, string>();
    for (const [field, sink] of [["exclude", excludeOf], ["note", noteOf]] as const) {
      for (const [key, text] of Object.entries(cfg[field] ?? {})) {
        const { hit, red } = lookupKey(index, key);
        if (red !== undefined || hit === undefined) {
          reds.push(`CONFIG · ${index.pkg.declaredAs}.${field} ${red}`);
          continue;
        }
        sink.set(contributionKey(hit.kind, hit.name), text);
      }
    }
    for (const c of index.manifest.contributions) {
      const key = contributionKey(c.kind, c.name);
      if (!SLUG_PATTERN[c.kind].test(c.name)) {
        reds.push(
          `GRAMMAR · ${index.pkg.name} contributes ${c.kind} "${c.name}", which eve's ${c.kind} slug pattern ` +
            `rejects — it would be discovered as an invalid slot, not mounted.`,
        );
        continue;
      }
      const reason = excludeOf.get(key);
      resolved.push({
        package: index.pkg.name,
        kind: c.kind,
        name: c.name,
        module: c.module,
        summary: c.summary,
        decision: reason === undefined ? "mounted" : "excluded",
        reason,
        note: noteOf.get(key),
      });
    }
  }

  const mounted = resolved.filter((r) => r.decision === "mounted");
  const byMountKey = new Map<string, ResolvedContribution[]>();
  for (const r of mounted) byMountKey.set(contributionKey(r.kind, r.name), [...(byMountKey.get(contributionKey(r.kind, r.name)) ?? []), r]);
  for (const [key, rows] of [...byMountKey].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (rows.length < 2) continue;
    reds.push(
      `COLLISION · ${rows.length} packages mount "${key}" (${rows.map((r) => r.package).join(", ")}). eve names a ` +
        `slot after its FILE, so only one can win. Fix: exclude it from all but one, with a reason.`,
    );
  }

  const frameworkDisabled: Record<string, string> = {};
  for (const [name, reason] of Object.entries(config.framework?.disable ?? {})) {
    if (input.frameworkToolNames !== undefined && !input.frameworkToolNames.includes(name)) {
      reds.push(
        `FRAMEWORK · framework.disable["${name}"] is not an eve framework tool ` +
          `(eve offers: ${[...input.frameworkToolNames].sort().join(", ")}). A sentinel for a non-built-in ` +
          `mounts nothing and hides nothing; eve's graph resolver rejects it too.`,
      );
      continue;
    }
    if (!SLUG_PATTERN.tool.test(name)) {
      reds.push(`GRAMMAR · framework.disable["${name}"] is not a legal eve tool slug.`);
      continue;
    }
    frameworkDisabled[name] = reason;
  }
  for (const r of mounted) {
    if (r.kind === "tool" && frameworkDisabled[r.name] !== undefined) {
      reds.push(
        `COLLISION · "${r.name}" is both mounted from ${r.package} and listed in framework.disable. ` +
          `One file, two intents — pick one.`,
      );
    }
  }

  const lockPackages: Record<string, { version: string; contributions: Record<string, LockedDecision> }> = {};
  for (const index of indexes) {
    const contributions: Record<string, LockedDecision> = {};
    for (const r of resolved.filter((x) => x.package === index.pkg.name)) {
      contributions[contributionKey(r.kind, r.name)] = r.decision;
    }
    lockPackages[index.pkg.name] = { version: index.pkg.version ?? "0.0.0", contributions: sortedRecord(contributions) };
  }
  const wouldLock: RosterLock = {
    schemaVersion: 1,
    generator: ROSTER_GENERATOR_VERSION,
    framework: sortedRecord(Object.fromEntries(Object.keys(frameworkDisabled).map((n) => [n, "disabled" as const]))),
    packages: sortedRecord(lockPackages),
  };

  const unreviewed: UnreviewedContribution[] = [];
  const vanished: VanishedContribution[] = [];
  const parsedLock = isRecord(input.lock) && isRecord(input.lock.packages) ? (input.lock as unknown as RosterLock) : undefined;
  if (input.lock !== undefined && parsedLock === undefined) {
    reds.push(`LOCK · roster.lock.json is present but is not a lock object. Fix: \`oe build --accept\`.`);
  }
  const lock: RosterLock | undefined =
    input.acceptLock === true ? undefined : (parsedLock ?? { schemaVersion: 1, generator: ROSTER_GENERATOR_VERSION, framework: {}, packages: {} });
  if (lock !== undefined) {
    for (const index of indexes) {
      const locked = lock.packages[index.pkg.name];
      if (locked === undefined || !isRecord(locked.contributions)) {
        for (const r of resolved.filter((x) => x.package === index.pkg.name)) {
          unreviewed.push({ package: r.package, kind: r.kind, name: r.name, module: r.module, summary: r.summary });
        }
        continue;
      }
      for (const r of resolved.filter((x) => x.package === index.pkg.name)) {
        const key = contributionKey(r.kind, r.name);
        const was = locked.contributions[key];
        if (was === undefined) {
          const c = index.byQualified.get(key);
          unreviewed.push({ package: r.package, kind: r.kind, name: r.name, module: r.module, summary: r.summary, since: c?.since });
          continue;
        }
        if (was !== r.decision) {
          reds.push(
            `LOCK · ${index.pkg.name} "${key}" is ${was} in roster.lock.json but ${r.decision} per roster.config.ts. ` +
              `The lock is the REVIEWED state — fix: \`oe build --accept\` and commit the lock diff.`,
          );
        }
      }
      for (const key of Object.keys(locked.contributions)) {
        if (index.byQualified.has(key)) continue;
        vanished.push({ package: index.pkg.name, kind: key.split("/")[0]!, name: key.slice(key.indexOf("/") + 1), lockedDecision: locked.contributions[key]! });
      }
    }
    const lockedFramework = isRecord(lock.framework) ? lock.framework : {};
    for (const name of Object.keys(frameworkDisabled)) {
      if (lockedFramework[name] === undefined) {
        reds.push(`LOCK · framework.disable["${name}"] is not in roster.lock.json. Fix: \`oe build --accept\`.`);
      }
    }
    for (const name of Object.keys(lockedFramework)) {
      if (frameworkDisabled[name] === undefined) {
        reds.push(
          `LOCK · roster.lock.json disables eve built-in "${name}" but roster.config.ts no longer does — ` +
            `that is a capability GAIN. Fix: \`oe build --accept\` and read the diff.`,
        );
      }
    }
  }
  if (unreviewed.length > 0) {
    for (const u of unreviewed) {
      reds.push(
        `UNREVIEWED · ${u.package} contributes ${u.kind} "${u.name}"${u.summary === undefined ? "" : ` — ${u.summary}`} ` +
          `which roster.lock.json has never seen. Decide it in roster.config.ts (mount by doing nothing, or add an ` +
          `\`exclude\` with a reason), then \`oe build --accept\`.`,
      );
    }
  }
  for (const v of vanished) {
    reds.push(
      `VANISHED · roster.lock.json reviewed ${v.package} ${v.kind} "${v.name}" (${v.lockedDecision}) but the package ` +
        `no longer offers it — a rename or a removal. Both are capability changes; \`oe build --accept\` records it.`,
    );
  }

  const providerRows: { id: string; pkg: string; module: string; exportName: string; about?: string }[] = [];
  for (const index of indexes) {
    if (index.pkg.providerId === undefined) continue;
    const register = index.manifest.register;
    if (register === undefined) {
      reds.push(
        `PROVIDER · ${index.pkg.name} is selected as a provider bundle but its manifest declares no \`register\` ` +
          `entry, so nothing would wire it at boot.`,
      );
      continue;
    }
    const [module, exportName] = register.split("#");
    providerRows.push({
      id: index.pkg.providerId,
      pkg: index.pkg.name,
      module: module!,
      exportName: exportName!,
      about: decisionConfig(index.pkg.decision).about,
    });
  }

  const structural = reds.filter((r) => !r.startsWith("UNREVIEWED ·") && !r.startsWith("VANISHED ·"));
  const verdict: RosterVerdict =
    structural.length > 0 ? "invalid" : unreviewed.length > 0 ? "unreviewed" : vanished.length > 0 ? "vanished" : "clean";

  const files: PlanFile[] = [];
  if (verdict !== "invalid") {
    for (const r of mounted) {
      files.push({
        path: `${agentDir}/${SLOT_DIR[r.kind]}/${r.name}.ts`,
        content: renderMountedShim(`${r.package}/${r.module}`, r.note),
      });
    }
    for (const [name, reason] of Object.entries(frameworkDisabled)) {
      files.push({ path: `${agentDir}/${SLOT_DIR.tool}/${name}.ts`, content: renderFrameworkSentinel(name, reason) });
    }
    files.push({ path: `${agentDir}/lib/providers.generated.ts`, content: renderProvidersModule(providerRows) });
    files.sort((a, b) => a.path.localeCompare(b.path));
  }

  return {
    verdict,
    reds,
    files,
    lock: wouldLock,
    resolved: [...resolved].sort((a, b) => contributionKey(a.kind, a.name).localeCompare(contributionKey(b.kind, b.name))),
    unreviewed,
    vanished,
    frameworkDisabled: sortedRecord(frameworkDisabled),
    selectedProviders: providerRows.map((p) => p.id),
  };
}

export function ownedSlotDirs(agentDir: string): string[] {
  return CONTRIBUTION_KINDS.map((k) => `${agentDir}/${SLOT_DIR[k]}`).sort((a, b) => a.localeCompare(b));
}

export function serializeLock(lock: RosterLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function goldenPlanLines(plan: PlanResult, agentDir: string): string[] {
  const lines: string[] = [];
  for (const r of plan.resolved) {
    if (r.decision !== "mounted") {
      lines.push(`(excluded)\t${r.kind}/${r.name}\texcluded ${r.package}: ${r.reason ?? ""}`.trimEnd());
      continue;
    }
    lines.push(`${agentDir}/${SLOT_DIR[r.kind]}/${r.name}.ts\tmounted ${r.package}`);
  }
  for (const name of Object.keys(plan.frameworkDisabled)) {
    lines.push(`${agentDir}/${SLOT_DIR.tool}/${name}.ts\tframework-disabled`);
  }
  lines.push(`${agentDir}/lib/providers.generated.ts\tproviders ${plan.selectedProviders.join(",")}`);
  return lines.sort((a, b) => a.localeCompare(b));
}

export function mountedRosterRows(plan: PlanResult): { readonly key: string; readonly value: string }[] {
  return rosterRows(
    plan.resolved.filter((r) => r.decision === "mounted").map((r) => ({ dir: SLOT_DIR[r.kind], name: r.name })),
    Object.keys(plan.frameworkDisabled),
  );
}

export function mountedRowsFromLock(lock: unknown): { readonly key: string; readonly value: string }[] {
  if (!isRecord(lock) || !isRecord(lock.packages)) return [{ key: "roster.lock.json", value: "<lock absent or unreadable>" }];
  const mounted: { dir: string; name: string }[] = [];
  for (const pkg of Object.values(lock.packages)) {
    if (!isRecord(pkg) || !isRecord(pkg.contributions)) continue;
    for (const [key, decision] of Object.entries(pkg.contributions)) {
      if (decision !== "mounted") continue;
      const kind = key.slice(0, key.indexOf("/")) as ContributionKind;
      const dir = SLOT_DIR[kind];
      if (dir === undefined) continue;
      mounted.push({ dir, name: key.slice(key.indexOf("/") + 1) });
    }
  }
  return rosterRows(mounted, isRecord(lock.framework) ? Object.keys(lock.framework) : []);
}

function rosterRows(
  mounted: readonly { readonly dir: string; readonly name: string }[],
  frameworkDisabled: readonly string[],
): { readonly key: string; readonly value: string }[] {
  const rows: { key: string; value: string }[] = [];
  const perDir = new Map<string, number>();
  const add = (key: string, value: string) => rows.push({ key, value });
  const planned: { dir: string; file: string; value: string }[] = [];
  for (const r of mounted) planned.push({ dir: r.dir, file: `${r.name}.ts`, value: PRIMITIVE_MOUNTED });
  for (const name of frameworkDisabled) planned.push({ dir: SLOT_DIR.tool, file: `${name}.ts`, value: PRIMITIVE_DISABLED });
  for (const p of planned) perDir.set(p.dir, (perDir.get(p.dir) ?? 0) + 1);
  for (const dir of [...new Set(planned.map((p) => p.dir))].sort((a, b) => a.localeCompare(b))) {
    add(`${dir}/`, `${perDir.get(dir)!} entr(y|ies)`);
  }
  for (const p of planned.sort((a, b) => `${a.dir}/${a.file}`.localeCompare(`${b.dir}/${b.file}`))) {
    add(`${p.dir}/${p.file}`, p.value);
  }
  return rows;
}
