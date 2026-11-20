import type { ToolSet } from "ai";
import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS, withheldFromGrain } from "../../agent/access/window-gate-manifest.js";
import { WORKER_UNMOUNTED_TOOLS, allowedOnWorkerSeat, restrictToolsetForWorkerSeat } from "../../agent/access/worker-seat.js";
import { WORKER_INDEX_MACHINERY } from "../../agent/access/worker-capabilities.js";
import { CONTRIBUTIONS } from "../../agent/contributions.js";
import type { BindableContext } from "../../agent/identity/binding.js";
import {
  createRecorder,
  eveFrameworkToolDefinition,
  eveNamedTool,
  evePublicTool,
  resolveDynamicEntry,
  type MountableEntry,
  type ResultFor,
  type ToolCall,
} from "./_offline-seat.js";

export function workerSeatCtx(parent: BindableContext): BindableContext {
  const parentToken = parent.channel?.continuationToken;
  const parentSessionId = typeof parentToken === "string" && parentToken.length > 0 ? parentToken : "oe-offline-parent";
  return {
    channel: { kind: "subagent", continuationToken: `subagent:${parentSessionId}:oe-offline-worker` },
    session: {
      parent: { sessionId: parentSessionId },
      auth: { current: { attributes: { ...(parent.session?.auth?.current?.attributes ?? {}) } } },
    },
  } as unknown as BindableContext;
}

function mountSurface(): readonly string[] {
  return [...new Set([...Object.keys(WINDOW_GATED_TOOLS), ...WINDOW_UNGATED_TOOLS])];
}

export function taskGrainMountSurface(): readonly string[] {
  const notOnTask = new Set(withheldFromGrain("task"));
  return mountSurface().filter((n) => !notOnTask.has(n)).sort();
}

export function workerSeatRoster(): readonly string[] {
  return taskGrainMountSurface().filter((n) => allowedOnWorkerSeat(n));
}

const EVE_FRAMEWORK_MODULES: Readonly<Record<string, { readonly subpath?: string; readonly dist?: string; readonly named?: string }>> = {
  eve__task_cancel: { dist: "tools/provided/task-cancel.js", named: "taskCancelTool" },
  eve__task_wait: { dist: "tools/provided/task-wait.js", named: "taskWaitTool" },
};

export const WORKER_SEAT_UNREACHABLE: Readonly<Record<string, string>> = {
  read_notion_page: "defined in packages/providers/notion — packages/core may not import a provider bundle (boundary lock rule 1)",
  read_notion_comments: "defined in packages/providers/notion — packages/core may not import a provider bundle (boundary lock rule 1)",
  notion_search: "defined in packages/providers/notion — packages/core may not import a provider bundle (boundary lock rule 1)",
  read_linear_issue: "defined in packages/providers/linear — packages/core may not import a provider bundle (boundary lock rule 1)",
  extend_workspace_time: "defined in @open-everywhere/adapters — packages/core may not import the adapters package (boundary lock rule 1)",
  fresh_eyes_review: "a declared subagent directory (agent/subagents/fresh_eyes_review) — eve lowers it into a tool at build time, so no importable definition exists",
  eve__skill:
    "eve provides it as a catalog route, only while the session's catalog holds a skill, and reserves the name; no public subpath exports a module whose default export is this verb",
  eve__search:
    "eve provides it as a catalog route, only while the session has connections or deferred entries; this synthetic world registers neither, and no module exports it",
  eve__tool:
    "same seam as eve__search — a catalog route eve provides while the session has connections or deferred entries, with no module of its own to import",
  eve__reply:
    "eve provides it only on a session that carries a structured output schema; a worker seat carries none, and no module exports it",
  notion:
    "a connector mount: its ops list only against a live server, so this offline seat does not run its resolver (a listing would reach the network or offer names outside the worker roster)",
  "slack-as-you":
    "an app-declared MCP server stub (agent/tools/slack-as-you.ts, which `oe build` writes from agent/access/mcp-servers.ts) — packages/core cannot import the app, and its connector ops list only against a live server",
  web_search:
    "eve 1.x ships it as a provider-executed tool: `eve/tools/web_search` exports only the `webSearch({ provider })` configuration, which the model provider runs, so no module exports a verb an offline seat can execute",
};

const CORE_TOOL_MODULES: ReadonlyMap<string, string> = new Map(
  (CONTRIBUTIONS.contributions as readonly { readonly kind: string; readonly name: string; readonly module: string }[])
    .filter((c) => c.kind === "tool")
    .map((c) => [c.name, c.module] as const),
);

function isSingleEntry(resolved: object): boolean {
  return (resolved as { readonly inputSchema?: unknown }).inputSchema !== undefined;
}

async function coreToolDefault(modulePath: string): Promise<unknown> {
  const mod = (await import(`../../${modulePath}`)) as { readonly default?: unknown };
  return mod.default ?? null;
}

async function mountCoreTool(
  name: string,
  ctx: BindableContext,
  rec: (name: string, entry: MountableEntry) => ToolSet[string],
  set: Record<string, ToolSet[string]>,
): Promise<readonly string[]> {
  const modulePath = CORE_TOOL_MODULES.get(name);
  if (modulePath === undefined) return [];
  const definition = await coreToolDefault(modulePath);
  if (definition === null) {
    throw new Error(
      `buildWorkerSeatToolset: agent/${modulePath} default-exports nothing, so "${name}" would mount as undefined and every assertion over it would be vacuous`,
    );
  }
  if (typeof definition === "object" && definition !== null && Symbol.for("eve.dynamic") in definition) {
    const resolved = await resolveDynamicEntry(definition, ctx);
    if (resolved === null) return [];
    if (isSingleEntry(resolved)) {
      set[name] = rec(name, resolved);
      return [name];
    }
    const provided: string[] = [];
    for (const [kitName, entry] of Object.entries(resolved as unknown as Record<string, MountableEntry>)) {
      set[kitName] = rec(kitName, entry);
      provided.push(kitName);
    }
    return provided;
  }
  set[name] = rec(name, definition as MountableEntry);
  return [name];
}

export async function buildWorkerSeatToolset(opts: {
  readonly ctx: BindableContext;
  readonly calls: ToolCall[];
  readonly resultFor: ResultFor;
  readonly onSkip?: (name: string, why: string) => void;
  readonly onRemoved?: (names: readonly string[]) => void;
  readonly roster?: readonly string[];
}): Promise<ToolSet> {
  const roster = opts.roster ?? workerSeatRoster();
  const rec = createRecorder(opts.calls, opts.resultFor);
  const set: Record<string, ToolSet[string]> = {};
  const onRoster = new Set(roster);
  const skipped = new Set<string>();
  const skip = (name: string, why: string): void => {
    skipped.add(name);
    if (onRoster.has(name)) opts.onSkip?.(name, why);
  };

  const attempt = [...new Set([...roster, ...WORKER_UNMOUNTED_TOOLS])];

  for (const name of attempt.filter((n) => WORKER_INDEX_MACHINERY.has(n) && CORE_TOOL_MODULES.has(n) && WORKER_SEAT_UNREACHABLE[n] === undefined)) {
    const provided = await mountCoreTool(name, opts.ctx, rec, set);
    skip(
      name,
      provided.length > 0
        ? `kit resolver — mounts nothing under its own name; it provided ${provided.join(", ")}`
        : "kit resolver — mounts nothing under its own name, and its kit mounted nothing on this seat",
    );
  }

  for (const name of attempt) {
    if (set[name] !== undefined || skipped.has(name)) continue;
    const unreachable = WORKER_SEAT_UNREACHABLE[name];
    if (unreachable !== undefined) {
      skip(name, unreachable);
      continue;
    }
    if (CORE_TOOL_MODULES.has(name)) {
      const mounted = await mountCoreTool(name, opts.ctx, rec, set);
      if (mounted.length === 0) skip(name, "its own shipped `session.started` resolver mounts nothing on this seat");
      continue;
    }
    const eveSeam = EVE_FRAMEWORK_MODULES[name];
    if (eveSeam !== undefined) {
      set[name] = rec(
        name,
        eveSeam.subpath !== undefined
          ? await evePublicTool(eveSeam.subpath)
          : eveSeam.named !== undefined
            ? await eveNamedTool(eveSeam.dist!, eveSeam.named)
            : await eveFrameworkToolDefinition(eveSeam.dist!),
      );
      continue;
    }
    throw new Error(
      `buildWorkerSeatToolset: the worker roster carries "${name}" and this builder has no mount arm and no skip arm for it — ` +
        "add one (a core `agent/contributions.ts` entry resolves itself; an eve verb goes in EVE_FRAMEWORK_MODULES; " +
        "a name no package here can import goes in WORKER_SEAT_UNREACHABLE with its reason). A roster name nobody tried " +
        "to resolve is an offline seat quietly narrower than the worker it claims to reproduce.",
    );
  }

  const removed = restrictToolsetForWorkerSeat(set);
  opts.onRemoved?.(removed);
  const leakedWithheld = Object.keys(set).filter((n) => WORKER_UNMOUNTED_TOOLS.has(n));
  if (leakedWithheld.length > 0) {
    throw new Error(`buildWorkerSeatToolset: withheld name(s) survived the subtraction: ${leakedWithheld.join(", ")}`);
  }
  const offRoster = Object.keys(set).filter((n) => !roster.includes(n));
  if (offRoster.length > 0) {
    throw new Error(
      `buildWorkerSeatToolset: mounted name(s) outside the worker roster: ${offRoster.join(", ")} — this seat would hand the model a verb the subtraction says a worker does not hold`,
    );
  }

  const accountedFor = new Set([...Object.keys(set), ...skipped]);
  const unaccounted = roster.filter((n) => !accountedFor.has(n));
  if (unaccounted.length > 0) {
    throw new Error(
      `buildWorkerSeatToolset: the worker roster carries name(s) this builder never resolves: ${unaccounted.join(", ")} — add a mount/skip arm (see the drift-guard note above)`,
    );
  }
  return set as ToolSet;
}
