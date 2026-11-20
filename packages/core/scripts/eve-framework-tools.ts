import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const RESERVATION_PATH = "dist/src/protocol/runtime-tools.js";

const PROTOCOL_DIR = "dist/src/protocol";

const RESERVED_NAME_EXPORTS = [
  ["catalog-tools.js", "SEARCH_TOOL_NAME"],
  ["catalog-tools.js", "CALL_TOOL_NAME"],
  ["catalog-tools.js", "SKILL_TOOL_NAME"],
  ["reply-tool.js", "REPLY_TOOL_NAME"],
] as const;

async function importEveModule(eveRoot: string, rel: string, why: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(join(eveRoot, rel)).href)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`eve framework tools: cannot read ${rel} from the installed eve (${String(cause)}). ${why}`, { cause });
  }
}

export async function readReservedFrameworkToolNames(eveRoot: string): Promise<string[]> {
  const policy = join(eveRoot, POLICY_PATH);
  if (existsSync(policy) && /CONNECTION_TOOL_SLOTS\s*=/u.test(readFileSync(policy, "utf8"))) {
    throw new Error(
      `eve framework tools: ${POLICY_PATH} declares \`CONNECTION_TOOL_SLOTS\` again. eve 0.76.0 retired that reserved-slot ` +
        `policy and reserves the \`eve__\` tool namespace instead, so this reader no longer reads the slot set. A ` +
        `returned slot family is a second reservation regime: read eve's compiler and teach this reader both, or ` +
        `every zero-hands gate demands a sentinel that \`eve build\` throws on.`,
    );
  }

  const reservation = (
    await importEveModule(
      eveRoot,
      RESERVATION_PATH,
      `It is eve's own rule for which tool names an app may not author (\`eveNamespaceReservation\`). Find its new home and update RESERVATION_PATH.`,
    )
  ).eveNamespaceReservation;
  if (typeof reservation !== "function") {
    throw new Error(
      `eve framework tools: ${RESERVATION_PATH} exports no \`eveNamespaceReservation\` function. eve moved or renamed the ` +
        `rule that reserves its built-in tool names. Without it this reader cannot prove that the names below are ` +
        `closed to an authored module, so it throws instead of guessing.`,
    );
  }
  const reservedBy = reservation as (name: string) => string | undefined;

  const names = new Set<string>();
  for (const [file, exportName] of RESERVED_NAME_EXPORTS) {
    const rel = `${PROTOCOL_DIR}/${file}`;
    const value = (
      await importEveModule(eveRoot, rel, `It declares one of eve's built-in model-visible tool names. Find the declaration's new home and update RESERVED_NAME_EXPORTS.`)
    )[exportName];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `eve framework tools: ${rel} exports no non-empty \`${exportName}\` string (got ${JSON.stringify(value)}). eve renamed ` +
          `or restructured the declaration. Read the module and update RESERVED_NAME_EXPORTS; a dropped name leaves ` +
          `a model-visible tool off every lint's surface.`,
      );
    }
    names.add(value);
  }
  for (const name of await readTaskToolNames(eveRoot)) names.add(name);

  const open = [...names].filter((name) => reservedBy(name) === undefined).sort();
  if (open.length > 0) {
    throw new Error(
      `eve framework tools: eve declares the built-in tool name(s) ${JSON.stringify(open)}, but its own ` +
        `\`eveNamespaceReservation\` does not reserve them. The reservation rule and the names moved apart. An ` +
        `unreserved name is an authorable slot, so the "reserved" class would excuse a slot that needs a posture.`,
    );
  }

  const declared = new Set<string>();
  for (const file of readdirSync(join(eveRoot, PROTOCOL_DIR)).filter((f) => f.endsWith(".js"))) {
    for (const [, name] of readFileSync(join(eveRoot, PROTOCOL_DIR, file), "utf8").matchAll(/[`"'](eve__[A-Za-z0-9_]+)[`"']/gu)) {
      declared.add(name!);
    }
  }
  const unread = [...declared].filter((name) => !names.has(name)).sort();
  if (unread.length > 0) {
    throw new Error(
      `eve framework tools: ${PROTOCOL_DIR}/ declares the reserved tool name(s) ${JSON.stringify(unread)}, which this ` +
        `reader does not read. eve added a built-in tool. Add its export to RESERVED_NAME_EXPORTS, so the window ` +
        `gate classes the new name before a session can hold it.`,
    );
  }
  return [...names].sort();
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
        `tool. Without it OE's posture tables for \`eve__task_wait\` / \`eve__task_cancel\` read as stale rows and the ` +
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
  readonly eveRoot?: string;
}

export async function readEveFrameworkTools(options: ReadEveFrameworkToolsOptions = {}): Promise<EveFrameworkTools> {
  const eveRoot = options.eveRoot ?? dirname(createRequire(options.resolveFrom ?? import.meta.url).resolve("eve/package.json"));

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

  const reserved = await readReservedFrameworkToolNames(eveRoot);
  const authorable = reserved.filter((name) => inRegistry.has(name) || OPT_IN_SNAPSHOT.includes(name as (typeof OPT_IN_SNAPSHOT)[number]));
  if (authorable.length > 0) {
    throw new Error(
      `eve framework tools: ${REGISTRY_PATH} or the opt-in snapshot carries the reserved name(s) ${JSON.stringify(authorable)}. ` +
        `A reserved name has no slot an app can author at, so it cannot also be a mounted or opt-in tool. One of the ` +
        `reads is stale; this throws rather than give the name two classes.`,
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
