export const PRIMITIVE_MOUNTED = "mounted";
export const PRIMITIVE_DISABLED = "disabled (disableTool sentinel)";

export type PrimitiveClassification = typeof PRIMITIVE_MOUNTED | typeof PRIMITIVE_DISABLED;

const SENTINEL = /export\s+default\s+disableTool\s*\(/u;

const REEXPORT = /export\s*\{\s*default\s*\}\s*from\s*["']([^"']+)["']/u;

export function classifyPrimitiveSource(source: string): PrimitiveClassification {
  return SENTINEL.test(source) ? PRIMITIVE_DISABLED : PRIMITIVE_MOUNTED;
}

export function reexportSpecifierOf(source: string): string | undefined {
  return REEXPORT.exec(source)?.[1];
}

export interface RosterEntry {
  readonly name: string;
  readonly classification: PrimitiveClassification;
  readonly reexportOf?: string;
}

export interface CoreToolExport {
  readonly name: string;
  readonly specifier: string;
}

export function coreToolSpecifier(name: string): string {
  return `@open-everywhere/core/agent/tools/${name}.js`;
}

export function isConventionFile(file: string): boolean {
  return file.endsWith(".ts") && !file.startsWith("_");
}

export function toolNameOf(file: string): string {
  return file.replace(/\.ts$/u, "");
}

export interface MisdirectedShim {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
}

export interface DanglingShim {
  readonly name: string;
  readonly specifier: string;
}

export interface RosterDrift {
  readonly missing: readonly CoreToolExport[];
  readonly misdirected: readonly MisdirectedShim[];
  readonly dangling: readonly DanglingShim[];
  readonly extra: readonly RosterEntry[];
  readonly mountedFromCore: readonly RosterEntry[];
  readonly declined: readonly RosterEntry[];
}

const CORE_TOOL_SPECIFIER = /^@open-everywhere\/core\/agent\/tools\/(.+)\.js$/u;

export function diffToolRoster(core: readonly CoreToolExport[], roster: readonly RosterEntry[]): RosterDrift {
  const coreNames = new Set(core.map((c) => c.name));
  const byName = new Map(roster.map((r) => [r.name, r]));

  const missing = core.filter((c) => !byName.has(c.name));
  const misdirected: MisdirectedShim[] = [];
  const dangling: DanglingShim[] = [];
  const extra: RosterEntry[] = [];
  const mountedFromCore: RosterEntry[] = [];
  const declined: RosterEntry[] = [];

  for (const entry of roster) {
    if (entry.classification === PRIMITIVE_DISABLED) declined.push(entry);
    const coreName = entry.reexportOf === undefined ? undefined : CORE_TOOL_SPECIFIER.exec(entry.reexportOf)?.[1];
    if (coreName === undefined) {
      if (!coreNames.has(entry.name)) extra.push(entry);
      continue;
    }
    if (coreName !== entry.name) {
      misdirected.push({ name: entry.name, expected: coreToolSpecifier(entry.name), actual: entry.reexportOf! });
      continue;
    }
    if (!coreNames.has(coreName)) {
      dangling.push({ name: entry.name, specifier: entry.reexportOf! });
      continue;
    }
    mountedFromCore.push(entry);
  }

  return { missing, misdirected, dangling, extra, mountedFromCore, declined };
}

export function rosterDriftIsClean(drift: RosterDrift): boolean {
  return drift.missing.length === 0 && drift.misdirected.length === 0 && drift.dangling.length === 0;
}

export function renderToolShim(name: string): string {
  return `export { default } from "${coreToolSpecifier(name)}";\n`;
}

export function renderDisableSentinel(name: string, reason: string): string {
  return (
    `// ${name} — DECLINED as a static tool: ${reason}\n` +
    `// A sentinel is how the roster records a REFUSAL. Deleting this file does not disable the\n` +
    `// tool, it un-decides it: \`npm run lint:tool-roster\` then reports the tool as MISSING.\n` +
    `import { disableTool } from "eve/tools";\n\n` +
    `export default disableTool();\n`
  );
}

export function generateMissingShims(drift: RosterDrift): { readonly file: string; readonly content: string }[] {
  return drift.missing.map((m) => ({ file: `${m.name}.ts`, content: renderToolShim(m.name) }));
}

export type CapabilityDirection = "gain" | "loss" | "neutral";

export function classifyRosterTransition(before: string | undefined, after: string | undefined): CapabilityDirection {
  const live = (v: string | undefined): boolean => v === PRIMITIVE_MOUNTED;
  const sentinel = (v: string | undefined): boolean => v === PRIMITIVE_DISABLED;
  if (live(after) && (before === undefined || sentinel(before))) return "gain";
  if (live(before) && (after === undefined || sentinel(after))) return "loss";
  return "neutral";
}

export function rosterToolNameOf(rowKey: string): string | undefined {
  return /^tools\/([^/]+)\.ts$/u.exec(rowKey)?.[1];
}
