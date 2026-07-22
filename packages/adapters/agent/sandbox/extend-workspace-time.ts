import { defineTool } from "eve/tools";
import { z } from "zod";
import { Sandbox } from "@vercel/sandbox";
import { auditToolAction } from "@open-everywhere/core/agent/adapter-api.js";
import { shouldStop } from "./vercel-lifecycle.js";

const DEFAULT_MAX_MINUTES = 120;

export function maxExtendMinutes(): number {
  const raw = Number(process.env.OE_SANDBOX_EXTEND_MAX_MIN);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_MINUTES;
}

export interface ExtendDeps {
  list(sessionId: string): Promise<Array<{ name: string; status: string }>>;
  extend(name: string, ms: number): Promise<void>;
}

const sdkDeps: ExtendDeps = {
  async list(sessionId) {
    const result = await Sandbox.list({ tags: { sessionId } });
    const out: Array<{ name: string; status: string }> = [];
    for await (const s of result) out.push({ name: s.name, status: s.status });
    return out;
  },
  async extend(name, ms) {
    await (await Sandbox.get({ name })).extendTimeout(ms);
  },
};

export async function extendSessionSandboxes(
  sessionId: string,
  minutes: number,
  deps: ExtendDeps = sdkDeps,
): Promise<{ extended: string[]; clampedTo: number }> {
  const clampedTo = Math.min(Math.max(1, Math.floor(minutes)), maxExtendMinutes());
  const extended: string[] = [];
  for (const s of await deps.list(sessionId)) {
    if (!shouldStop(s.status)) continue;
    await deps.extend(s.name, clampedTo * 60_000);
    extended.push(s.name);
  }
  return { extended, clampedTo };
}

export default defineTool({
  description:
    "Extend your workspace VM's lifetime by N minutes. Call this BEFORE starting a long-running command " +
    "(a big install, build, or a test run you expect to take more than ~10 minutes): the workspace has a " +
    "fixed time window and a command still running when it expires is killed. There is no visible countdown, " +
    "so extend by roughly the time the upcoming work needs. If no VM is currently running, nothing needs " +
    "extending — your next command boots a fresh one with a full window.",
  inputSchema: z.object({
    minutes: z.number().int().min(1).describe("How many extra minutes the upcoming work needs."),
    reason: z.string().optional().describe("What the time is for (goes to the audit log)."),
  }),
  async execute(input, ctx) {
    const { extended, clampedTo } = await extendSessionSandboxes(ctx.session.id, input.minutes);
    await auditToolAction(ctx, "sandbox.extend", {
      minutes: clampedTo,
      requested: input.minutes,
      extended,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    if (extended.length === 0) {
      return "No workspace VM is currently running — nothing to extend. Your next command boots a fresh session with a full time window, so just proceed.";
    }
    const clampNote = clampedTo !== input.minutes ? ` (requested ${input.minutes}, capped at ${clampedTo} by OE_SANDBOX_EXTEND_MAX_MIN)` : "";
    return `Extended the workspace lifetime by ${clampedTo} minutes${clampNote}. Start the long-running work now.`;
  },
});
