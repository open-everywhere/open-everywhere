import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REGISTRY_PATH = "dist/src/framework/sources/registry.js";

const POLICY_PATH = "dist/src/compiler/default-tool-policy.js";

const TASK_TOOLS_PATH = "dist/src/protocol/task-tools.js";

const OPT_IN_SNAPSHOT = ["ask_question", "glob", "grep"] as const;

interface FrameworkSourceRegistry {
  readonly registrations: readonly {
    readonly applyTo: string;
    readonly source: { readonly modules: readonly { readonly logicalPath: string }[] };
  }[];
}

export interface EveFrameworkTools {
  readonly all: readonly string[];
  readonly defaultMounted: readonly string[];
  readonly optIn: readonly string[] | undefined;
  readonly rootOnly: readonly string[];
  readonly optInDrift: string | undefined;
  readonly reserved: readonly string[];
  readonly taskTools: readonly string[];
}

export function readReservedFrameworkToolSlots(eveRoot: string): string[] {
  const file = join(eveRoot, POLICY_PATH);
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const declaration = /CONNECTION_TOOL_SLOTS\s*=\s*new Set\(\[([^\]]*)\]\)/u.exec(source);
  if (declaration === null) {
    throw new Error(
      `eve framework tools: ${POLICY_PATH} exists but declares no readable ` +
        `\`CONNECTION_TOOL_SLOTS = new Set([...])\`. eve restructured the policy that declares which framework ` +
        `tool slots an app may author nothing at. Guessing is not safe in both directions: an OVER-report ` +
        `exempts a slot from the sentinel demand and lets a hands-on tool sit there unreviewed, and an ` +
        `UNDER-report leaves the failure to surface as an \`eve build\` throw naming eve's file instead of OE's ` +
        `zero-hands invariant. Read eve's policy module and update this reader.`,
    );
  }

  const constants = new Map<string, string>();
  for (const [, name, slot] of source.matchAll(/([A-Z_]+)\s*=\s*`(tools\/[a-z_]+)`/gu)) constants.set(name!, slot!);

  const entries = declaration[1]!
    .split(",")
    .map((entry) => entry.trim().replace(/^["'`]|["'`]$/gu, ""))
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith("tools/") ? entry : (constants.get(entry) ?? entry)));
  const unresolved = entries.filter((entry) => !/^tools\/[A-Za-z0-9_]+$/u.test(entry));
  if (unresolved.length > 0) {
    throw new Error(
      `eve framework tools: ${POLICY_PATH} declares CONNECTION_TOOL_SLOTS with entr(ies) this reader cannot ` +
        `resolve to a \`tools/<name>\` slot: ${JSON.stringify(unresolved)}. eve spells the set with a mix of ` +
        `literals and constants, so a RENAMED constant lands here. Extend the constant resolution rather than ` +
        `letting the entry drop: a dropped entry under-reports the reserved set, and \`connection_tools\` is ` +
        `also DEFAULT-MOUNTED, so dropping it makes every zero-hands gate demand a sentinel \`eve build\` throws on.`,
    );
  }
  return [...new Set(entries.map((entry) => entry.slice("tools/".length)))].sort();
}

export async function readTaskToolNames(eveRoot: string): Promise<string[]> {
  let names: unknown;
  try {
    const mod = (await import(pathToFileURL(join(eveRoot, TASK_TOOLS_PATH)).href)) as { TASK_TOOL_NAMES?: unknown };
    names = mod.TASK_TOOL_NAMES;
  } catch (cause) {
    throw new Error(
      `eve framework tools: cannot read ${TASK_TOOLS_PATH} from the installed eve (${String(cause)}). It is ` +
        `eve's own declaration of the task verbs it injects per model call and reserves against an authored ` +
        `tool. Without it OE's posture tables for \`task_wait\` / \`task_cancel\` read as stale rows and the ` +
        `names leave every lint's surface. Find the module's new home and update TASK_TOOLS_PATH.`,
      { cause },
    );
  }
  if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== "string")) {
    throw new Error(
      `eve framework tools: ${TASK_TOOLS_PATH} exports no non-empty \`TASK_TOOL_NAMES\` string array (got ` +
        `${JSON.stringify(names)}). eve renamed or restructured the declaration; read the module rather than ` +
        `listing the names here, because a hand-kept list stops tracking the pin the day it moves.`,
    );
  }
  return [...new Set(names as string[])].sort();
}

function toolNameOf(logicalPath: string): string | undefined {
  const m = /^tools\/(.+)\.ts$/u.exec(logicalPath);
  return m?.[1];
}

export interface RegistryMountSets {
  readonly defaultMounted: ReadonlySet<string>;
  readonly rootOnly: ReadonlySet<string>;
  readonly inRegistry: ReadonlySet<string>;
}

export function deriveRegistryMountSets(registrations: FrameworkSourceRegistry["registrations"]): RegistryMountSets {
  const defaultMounted = new Set<string>();
  const rootOnly = new Set<string>();
  const inRegistry = new Set<string>();
  const unknownScopes = new Set<string>();
  for (const registration of registrations) {
    for (const module of registration.source.modules) {
      const name = toolNameOf(module.logicalPath);
      if (name === undefined) continue;
      inRegistry.add(name);
      if (registration.applyTo === "all-local-nodes") defaultMounted.add(name);
      else if (registration.applyTo === "root") rootOnly.add(name);
      else unknownScopes.add(registration.applyTo);
    }
  }

  if (defaultMounted.size === 0 || rootOnly.size === 0) {
    throw new Error(
      `eve framework tools: ${REGISTRY_PATH} yielded ${defaultMounted.size} default-mounted and ` +
        `${rootOnly.size} root-only tools; both must be non-empty. eve restructured its source registry ` +
        `(the \`applyTo\` scopes, or the \`tools/<name>.ts\` logical-path convention). An empty set here is ` +
        `fail-OPEN — every framework-tool lint would check nothing — so this throws.`,
    );
  }
  if (unknownScopes.size > 0) {
    throw new Error(
      `eve framework tools: ${REGISTRY_PATH} registers tools under \`applyTo\` scope(s) this reader does not ` +
        `know: ${[...unknownScopes].sort().join(", ")}. Only "all-local-nodes" (default-mounted) and "root" ` +
        `(root-only) are classified. Read eve's compiler to see which nodes the new scope reaches, then add it ` +
        `here — guessing its mount class either demands a disableTool() sentinel eve will reject at build time, ` +
        `or excuses one that is genuinely needed.`,
    );
  }
  return { defaultMounted, rootOnly, inRegistry };
}

export interface ReadEveFrameworkToolsOptions {
  readonly resolveFrom?: string;
}

export async function readEveFrameworkTools(options: ReadEveFrameworkToolsOptions = {}): Promise<EveFrameworkTools> {
  const require = createRequire(options.resolveFrom ?? import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));

  let registry: FrameworkSourceRegistry;
  try {
    const mod = (await import(pathToFileURL(join(eveRoot, REGISTRY_PATH)).href)) as {
      frameworkAgentSourceRegistry?: FrameworkSourceRegistry;
    };
    const found = mod.frameworkAgentSourceRegistry;
    if (found === undefined) throw new Error(`${REGISTRY_PATH} exports no \`frameworkAgentSourceRegistry\``);
    registry = found;
  } catch (cause) {
    throw new Error(
      `eve framework tools: cannot read ${REGISTRY_PATH} from the installed eve (${String(cause)}). ` +
        `This is eve's own enumeration of the tools it mounts; without it every framework-tool lint checks ` +
        `NOTHING and passes, which is why this throws instead of degrading. eve moved this module once ` +
        `already (0.45.0 deleted runtime/framework-tools/index.js) — find its new home and update ` +
        `REGISTRY_PATH in this file.`,
      { cause },
    );
  }

  const { defaultMounted, rootOnly, inRegistry } = deriveRegistryMountSets(registry.registrations);

  const exports = JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const exportMap = exports.exports ?? {};
  const drift: string[] = [];
  for (const name of OPT_IN_SNAPSHOT) {
    if (exportMap[`./tools/${name}`] === undefined) {
      drift.push(`"${name}" has no \`./tools/${name}\` entry in eve's exports map — the app can no longer opt into it`);
    }
    if (inRegistry.has(name)) {
      drift.push(`"${name}" now appears in eve's source registry — it is mounted, not opt-in`);
    }
  }
  const optInDrift =
    drift.length === 0
      ? undefined
      : `the committed opt-in snapshot [${OPT_IN_SNAPSHOT.join(", ")}] no longer matches the installed eve: ` +
        `${drift.join("; ")}. Every framework tool now classifies "unknown", so each grain-gated one demands a ` +
        `disableTool() sentinel until the snapshot is re-pinned.`;

  const optIn = optInDrift === undefined ? [...OPT_IN_SNAPSHOT] : undefined;

  const reserved = readReservedFrameworkToolSlots(eveRoot);
  if (reserved.length > 0 && !reserved.some((name) => inRegistry.has(name))) {
    throw new Error(
      `eve framework tools: ${POLICY_PATH} reserves ${reserved.join(", ")} but ${REGISTRY_PATH} registers none of ` +
        `them, so nothing mounts the family they belong to. One of the two reads is stale. Guessing would put ` +
        `names on OE's surface that no session can hold, or take live ones off it, so this throws instead.`,
    );
  }
  const taskTools = await readTaskToolNames(eveRoot);

  const all = [...new Set([...inRegistry, ...(optIn ?? []), ...reserved, ...taskTools])].sort();

  return {
    all,
    defaultMounted: [...defaultMounted].sort(),
    optIn: optIn === undefined ? undefined : [...optIn].sort(),
    rootOnly: [...rootOnly].sort(),
    optInDrift,
    reserved,
    taskTools,
  };
}
