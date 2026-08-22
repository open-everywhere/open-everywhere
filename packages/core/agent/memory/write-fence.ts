import type { ToolContext, ToolDefinition } from "eve/tools";
import type { BindableContext } from "../identity/binding.js";
import { bindFrom } from "../identity/binding.js";
import { resolvePartition } from "./partition.js";
import { planFor, type MemoryPlan, type ResolvedMemory } from "./resolve.js";
import { tierSandboxDir } from "./sandbox-sync.js";
import { isProjectedCache } from "./readonly.js";

const SANDBOX_CWD = ["workspace"] as const;

const MEMORY_ROOT = "memory";

const MEMORY_INDEX = "MEMORY.md";

export function absoluteSandboxSegments(raw: string): string[] {
  const out: string[] = raw.startsWith("/") ? [] : [...SANDBOX_CWD];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

export interface MemoryWriteTarget {
  readonly dir: string;
  readonly rel: string;
  readonly sandboxDir: string;
}

export function memoryWriteTarget(raw: string): MemoryWriteTarget | null {
  const path = raw.trim();
  if (path === "") return null;
  const segs = absoluteSandboxSegments(path);
  if (segs.length < 2) return null;
  if (segs[0] !== SANDBOX_CWD[0] || segs[1] !== MEMORY_ROOT) return null;
  const rest = segs.slice(2);
  const dir = rest[0] ?? "";
  return { dir, rel: rest.slice(1).join("/"), sandboxDir: `${MEMORY_ROOT}/${dir}` };
}

function writableNames(plan: MemoryPlan): string[] {
  return plan.writes.map((w) => w.silo.name);
}

function writableClause(plan: MemoryPlan): string {
  const names = writableNames(plan);
  if (names.length === 0) {
    return `This session has NO writable memory (${plan.reason}), so nothing under /workspace/memory/ will save.`;
  }
  const dirs = plan.writes.map((w) => `\`${tierSandboxDir(w.tier)}/\` (silo "${w.silo.name}")`);
  return `The memory you CAN write here is ${dirs.join(", ")} — ${plan.reason}.`;
}

function readOnlyRoute(rm: ResolvedMemory, plan: MemoryPlan): string {
  if (isProjectedCache(rm.silo)) {
    const via = rm.silo.skill ? `the \`${rm.silo.skill}\` skill` : "the Notion tools";
    return `It is a READ-ONLY cache of Notion — update the source with ${via}, and the cache refreshes from it.`;
  }
  return `It is a READ-ONLY baseline. ${writableClause(plan)}`;
}

export function memoryWriteRefusal(rawPath: string, plan: MemoryPlan): string | null {
  const target = memoryWriteTarget(rawPath);
  if (target === null) return null;

  if (target.rel === "") {
    const what =
      target.dir === MEMORY_INDEX
        ? `\`memory/${MEMORY_INDEX}\` is the host-generated memory index. It is rebuilt from the session's plan every session, so an edit here is overwritten and never saved.`
        : `\`${rawPath}\` does not name a file inside a memory silo. Memory files live one level down, at \`memory/<silo>/<file>.md\`.`;
    return `${what} ${writableClause(plan)}`;
  }

  const write = plan.writes.find((w) => tierSandboxDir(w.tier) === target.sandboxDir);
  if (write) return null;

  const read = plan.reads.find((r) => tierSandboxDir(r.tier) === target.sandboxDir);
  if (read) {
    return `\`${rawPath}\` is inside the "${read.silo.name}" silo, which this session reads but cannot write. ${readOnlyRoute(read, plan)}`;
  }

  return (
    `\`${rawPath}\` is not a memory silo this session owns. Writing there would look like it worked ` +
    `and then be DROPPED — nothing persists a directory outside the session's plan — so it is refused. ` +
    `${writableClause(plan)} If you expected "${target.dir}", this session is not in that domain: say so ` +
    `rather than writing, because the write cannot reach it from here.`
  );
}

export function assertMemoryWriteAllowed(toolName: string, filePath: string, ctx: ToolContext): void {
  if (memoryWriteTarget(filePath) === null) return;
  let plan: MemoryPlan;
  try {
    const bindable = ctx as unknown as BindableContext;
    plan = planFor(bindFrom(bindable), resolvePartition(bindable));
  } catch (err) {
    throw new Error(
      `${toolName}: refusing to write \`${filePath}\` — this session's memory plan could not be read ` +
        `(${String(err)}), so there is no way to tell whether that silo would persist. A write that ` +
        `cannot be checked is refused, because an unowned one is dropped silently.`,
    );
  }
  const refusal = memoryWriteRefusal(filePath, plan);
  if (refusal) throw new Error(`${toolName}: ${refusal}`);
}

export function withMemoryWriteFence(toolName: string, tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    async execute(input: unknown, ctx: ToolContext) {
      const filePath = (input as { filePath?: unknown } | null | undefined)?.filePath;
      if (typeof filePath === "string") assertMemoryWriteAllowed(toolName, filePath, ctx);
      return tool.execute(input, ctx);
    },
  };
}
