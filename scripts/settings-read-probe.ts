import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { posixRelative, toPosixPath } from "./posix-path.js";

export const SETTINGS_SLOT_KEY = Symbol.for("open-everywhere.settings.registered.v1");

export interface EagerSettingsRead {
  readonly file: string;
  readonly line: number;
  readonly accessor: string;
}

export function eagerReadKey(read: Pick<EagerSettingsRead, "file" | "accessor">): string {
  return `${read.file}::${read.accessor}`;
}

interface Frame {
  readonly name: string;
  readonly location: string;
}

const FRAME = /^\s*at\s+(?:(.+?)\s+\((.+)\)|(.+))$/;

function parseFrames(stack: string): Frame[] {
  const out: Frame[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = FRAME.exec(line);
    if (m === null) continue;
    out.push(m[2] !== undefined ? { name: m[1], location: m[2] } : { name: "<anonymous>", location: m[3] });
  }
  return out;
}

function splitLocation(location: string, repoRoot: string): { file: string; line: number } {
  const at = /^(.*?):(\d+):\d+$/.exec(location.replace(/^file:\/\//, ""));
  let raw = at === null ? location : at[1];
  let rootPath = repoRoot;
  if (sep === "\\") {
    raw = toPosixPath(raw).replace(/^\/(?=[A-Za-z]:\/)/, "");
    rootPath = toPosixPath(repoRoot);
  }
  const root = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return { file: raw.startsWith(root) ? raw.slice(root.length) : raw, line: at === null ? 0 : Number(at[2]) };
}

export function siteFromStack(stack: string, repoRoot: string, probeFile: string): EagerSettingsRead | null {
  const frames: Frame[] = [];
  for (const frame of parseFrames(stack)) {
    if (frame.location.startsWith("node:")) break;
    if (splitLocation(frame.location, repoRoot).file === probeFile) continue;
    frames.push(frame);
  }
  if (frames.length === 0) return null;
  const site = frames[frames.length - 1];
  const above = frames.length >= 2 ? frames[frames.length - 2] : null;
  const { file, line } = splitLocation(site.location, repoRoot);
  const accessor = above === null || above.name === "<anonymous>" ? site.name : above.name;
  return { file, line, accessor };
}

export interface SettingsReadProbe {
  reads(): readonly EagerSettingsRead[];
  trapCount(): number;
  clear(): void;
  installed(): boolean;
}

export function installSettingsReadProbe(
  repoRoot: string,
  probeFile: string = posixRelative(repoRoot, fileURLToPath(import.meta.url)),
): SettingsReadProbe {
  const reads: EagerSettingsRead[] = [];
  const seen = new Set<string>();
  let traps = 0;

  const recorder = new Proxy(Object.freeze({}), {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      traps++;
      const site = siteFromStack(new Error("eager settings read").stack ?? "", repoRoot, probeFile);
      if (site !== null) {
        const key = eagerReadKey(site);
        if (!seen.has(key)) {
          seen.add(key);
          reads.push(site);
        }
      }
      return undefined;
    },
  });

  const g = globalThis as Record<symbol, unknown>;
  if (!(g[SETTINGS_SLOT_KEY] instanceof Object) || !("oeSlot" in (g[SETTINGS_SLOT_KEY] as object))) {
    g[SETTINGS_SLOT_KEY] = { oeSlot: null };
  }
  const box = g[SETTINGS_SLOT_KEY] as { oeSlot: unknown };
  box.oeSlot = recorder;

  return {
    reads: () => reads,
    trapCount: () => traps,
    clear: () => {
      reads.length = 0;
      seen.clear();
      traps = 0;
    },
    installed: () => box.oeSlot === recorder,
  };
}

export const EAGER_SETTINGS_READ_ALLOWLIST: ReadonlyMap<string, string> = new Map<string, string>([]);

export const EAGER_READ_REMEDY =
  "Move the read to the point of use: call the accessor inside the function that needs the answer, " +
  "or expose the value through a getter. A module-level read runs before " +
  "agent/lib/register-config.ts registers this deployment's overrides, so it pins the SHIPPED " +
  "schema default and the deployment's own agent/settings/settings.ts silently never applies. " +
  "See packages/core/agent/settings/settings.ts (getSettings) and scripts/settings-read-probe.ts.";

export function auditEagerReads(
  reads: readonly EagerSettingsRead[],
  allowlist: ReadonlyMap<string, string> = EAGER_SETTINGS_READ_ALLOWLIST,
): string[] {
  const problems: string[] = [];
  const matched = new Set<string>();
  for (const read of reads) {
    const key = eagerReadKey(read);
    if (allowlist.has(key)) {
      matched.add(key);
      continue;
    }
    problems.push(
      `${read.file}:${read.line} reads settings through ${read.accessor}() at MODULE LEVEL — it runs ` +
        `before registerSettings(), so it pins the shipped default (key ${key}).`,
    );
  }
  for (const key of allowlist.keys()) {
    if (matched.has(key)) continue;
    problems.push(
      `allowlist entry ${key} matches no eager read on the boot path any more — delete it. The list ` +
        "is shrink-only; a dead excuse is how a ratchet turns into a rubber stamp.",
    );
  }
  return problems;
}
