import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REGISTRY_PATH = "dist/src/framework/sources/registry.js";

const POLICY_PATH = "dist/src/compiler/default-tool-policy.js";

const OPT_IN_SNAPSHOT = ["glob", "grep"] as const;

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
  readonly required: readonly string[];
}

export function readRequiredFrameworkToolSlots(eveRoot: string): string[] {
  const file = join(eveRoot, POLICY_PATH);
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const declaration = /REQUIRED_FRAMEWORK_TOOL_SLOTS\s*=\s*new Set\(\[([^\]]*)\]\)/u.exec(source);
  if (declaration === null) {
    throw new Error(
      `eve framework tools: ${POLICY_PATH} exists but declares no readable ` +
        `\`REQUIRED_FRAMEWORK_TOOL_SLOTS = new Set([...])\`. eve restructured the policy that decides which ` +
        `framework tool slots refuse a disableTool() sentinel. Guessing is not safe in both directions: an ` +
        `OVER-report exempts a slot from the sentinel demand and lets a hands-on tool sit there unreviewed, ` +
        `and an UNDER-report leaves the failure to surface as an \`eve build\` throw naming eve's file instead ` +
        `of OE's zero-hands invariant. Read eve's policy module and update this reader.`,
    );
  }

  const slots: string[] = [];
  for (const [, name] of declaration[1]!.matchAll(/["'`]tools\/([A-Za-z0-9_]+)\.?[a-z]*["'`]/gu)) {
    slots.push(name!);
  }
  if (declaration[1]!.trim() !== "" && slots.length === 0) {
    throw new Error(
      `eve framework tools: ${POLICY_PATH} declares REQUIRED_FRAMEWORK_TOOL_SLOTS with entries this reader ` +
        `cannot parse (${declaration[1]!.trim()}). Only \`tools/<name>\` slot literals are understood. Half of ` +
        `guessing wrong here is fail-OPEN — see the note above.`,
    );
  }
  return [...new Set(slots)].sort();
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
  const all = [...new Set([...inRegistry, ...(optIn ?? [])])].sort();

  const required = readRequiredFrameworkToolSlots(eveRoot);
  const unmounted = required.filter((name) => !defaultMounted.has(name));
  if (unmounted.length > 0) {
    throw new Error(
      `eve framework tools: ${POLICY_PATH} requires slot(s) ${unmounted.join(", ")} that ${REGISTRY_PATH} does ` +
        `not register for "all-local-nodes". One of the two reads is stale. A required-but-unmounted slot would ` +
        `make the subagent lint demand a replacement tool in a slot eve never mounts, so this throws rather ` +
        `than guessing which read to believe.`,
    );
  }

  return {
    all,
    defaultMounted: [...defaultMounted].sort(),
    optIn: optIn === undefined ? undefined : [...optIn].sort(),
    rootOnly: [...rootOnly].sort(),
    optInDrift,
    required,
  };
}
