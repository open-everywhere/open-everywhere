import { readFileSync } from "node:fs";
import { tool, type ToolSet } from "ai";
import type { z } from "zod";
import replyDynamic from "../../agent/tools/reply.js";
import noReplyTool from "../../agent/tools/no_reply.js";
import updateStatusTool from "../../agent/tools/update_status.js";
import standDownTool from "../../agent/tools/stand_down.js";
import reactDynamic from "../../agent/tools/react.js";
import spawnThreadSessionDynamic from "../../agent/tools/spawn_thread_session.js";
import readChannelDynamic from "../../agent/tools/read_channel.js";
import readThreadDynamic from "../../agent/tools/read_thread.js";
import editReplyDynamic from "../../agent/tools/edit_reply.js";
import stopTaskDynamic from "../../agent/tools/stop_task.js";
import spawnTaskDynamic from "../../agent/tools/spawn_task.js";
import completeThreadDynamic from "../../agent/tools/complete_thread.js";
import setDmDeliveryDynamic from "../../agent/tools/set_dm_delivery.js";
import { renderScopeMarkdown } from "../../agent/instructions/access.js";
import { registerConfig } from "../../agent/access/config.js";
import { defineDomain } from "../../agent/memory/domain.js";
import { defineMemorySilo } from "../../agent/memory/silo.js";
import { registerSlackFixtureMapper, registerSlackFixtureManifest } from "../_slack-test-stubs.js";
import { registerCapabilityManifest } from "../../agent/identity/capabilities.js";
import { overrideSettingsForTest } from "../../agent/settings/settings.js";
import type { BindableContext } from "../../agent/identity/binding.js";
import { LEAN_SEAT_TOOLS } from "../../agent/access/lean-seat.js";

export const DOMAIN = "payments";
export const SLACK_CHANNEL = "C_PAY";
export const SLACK_TEAM = "T_PAY";

export function registerSyntheticConfig(opts: { readonly unified: boolean }): void {
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [
      defineDomain({
        name: DOMAIN,
        channels: [`slack/${SLACK_TEAM}/${SLACK_CHANNEL}`, "notion/W_PAY/P_PAY", "github/acme/payments-api"],
        memory: "payments-notes",
        ambientSupervisor: true,
        ...(opts.unified ? { mode: "unified" as const } : {}),
      }),
      defineDomain({ name: "org", match: "org" }),
    ],
    loadSilos: () => [defineMemorySilo({ name: "payments-notes", description: "payments-domain decisions", provider: "sqlite" })],
    domainsForSurface: ({ surface }: { surface: string }) => ([SLACK_CHANNEL, "P_PAY", "payments-api"].includes(surface) ? [DOMAIN] : []),
  } as never);
  registerSlackFixtureMapper();
  registerSlackFixtureManifest();
}

export const unifiedCtx: BindableContext = {
  channel: { kind: "channel:unified", continuationToken: `oe-dom:${DOMAIN}:oe-sup:g1` },
  session: { auth: { current: { attributes: { oe_platform: "slack" } } } },
} as BindableContext;

export const perSurfaceCtx: BindableContext = {
  channel: { kind: "slack", continuationToken: `${SLACK_CHANNEL}:oe-sup:g1` },
  session: {
    auth: {
      current: {
        attributes: { team_id: SLACK_TEAM, channel_id: SLACK_CHANNEL, channel_type: "channel", is_private: "false", trust_checked: "true" },
        principalId: "U_ALEX",
        principalType: "user",
      },
    },
  },
} as BindableContext;

export const GITHUB_REPO = "acme/payments-api";
export const LINEAR_TEAM = "T_PAY";

export function ticketingCtx(platform: "github" | "linear"): BindableContext {
  const token = platform === "github" ? `github:${GITHUB_REPO}:oe-sup:g1` : `linear:${LINEAR_TEAM}:oe-sup:g1`;
  return {
    channel: { kind: platform, continuationToken: token },
    session: { auth: { current: { attributes: {} } } },
  } as BindableContext;
}

export function registerTicketingFixtureManifests(): void {
  registerCapabilityManifest("github", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
  registerCapabilityManifest("linear", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
}

export function readBaseInstructions(): string {
  return readFileSync(new URL("../../../../agent/instructions.md", import.meta.url), "utf8");
}

export async function buildShippedSystemPrompt(
  ctx: BindableContext,
  patchBase?: (base: string) => string,
): Promise<string> {
  const raw = readBaseInstructions();
  const base = patchBase === undefined ? raw : patchBase(raw);
  return `${base}\n\n${await renderScopeMarkdown(ctx)}`;
}

export function markdownSection(md: string, heading: string): string {
  const i = md.indexOf(heading);
  if (i < 0) throw new Error(`the '${heading}' section is not in the file — an arm built from it would be a no-op reported as a swap`);
  const j = md.indexOf("\n## ", i + 1);
  return j < 0 ? md.slice(i) : md.slice(i, j + 1);
}

export function swapMarkdownSection(md: string, heading: string, replacement: string): string {
  const current = markdownSection(md, heading);
  const at = md.indexOf(current);
  if (md.indexOf(current, at + 1) >= 0) throw new Error(`the '${heading}' section appears twice — refusing an ambiguous swap`);
  return md.slice(0, at) + replacement + md.slice(at + current.length);
}

export interface ToolCall { readonly name: string; readonly input: Record<string, unknown> }

export interface MountableEntry {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly toModelOutput?: (output: unknown) => unknown;
}

const realSchema = (entry: { readonly inputSchema: unknown }): z.ZodType => entry.inputSchema as z.ZodType;

export type ResultFor = (name: string, input: Record<string, unknown>, callIndex: number) => unknown;

export function createRecorder(calls: ToolCall[], resultFor: ResultFor) {
  return (name: string, entry: MountableEntry): ToolSet[string] =>
    tool({
      description: entry.description,
      inputSchema: realSchema(entry),
      execute: async (input: unknown) => {
        const typed = input as Record<string, unknown>;
        calls.push({ name, input: typed });
        return resultFor(name, typed, calls.length);
      },
      ...(entry.toModelOutput
        ? { toModelOutput: async (args: { readonly output: unknown }) => entry.toModelOutput!(args.output) }
        : {}),
    } as never);
}

export async function resolveDynamicEntry(mod: unknown, ctx: BindableContext): Promise<MountableEntry | null> {
  const started = (mod as { events?: Record<string, (e: unknown, c: unknown) => unknown> }).events?.["session.started"];
  if (started === undefined) return null;
  const resolved = await started({}, ctx);
  return resolved === null || resolved === undefined ? null : (resolved as MountableEntry);
}

export async function eveFrameworkTool(file: string): Promise<Record<string, unknown>> {
  const base = import.meta.resolve("eve/tools").replace(/\/src\/.*$/, "/src/runtime/framework-tools/");
  return (await import(base + file)) as Record<string, unknown>;
}

export async function replyEntryForSeat(ctx: BindableContext): Promise<MountableEntry> {
  const entry = await resolveDynamicEntry(replyDynamic, ctx);
  if (entry === null) throw new Error("the reply dynamic mounts NOTHING on this seat (no mid-turn post primitive) — every offline criterion reads reply calls, so this run would score zeros that mean nothing");
  return entry;
}

export async function tryReplyEntryForSeat(ctx: BindableContext): Promise<MountableEntry | null> {
  return await resolveDynamicEntry(replyDynamic, ctx);
}

export async function buildLeanSeatToolset(opts: {
  readonly ctx: BindableContext;
  readonly calls: ToolCall[];
  readonly resultFor: ResultFor;
  readonly onSkip?: (name: string) => void;
  readonly allowNoReply?: boolean;
}): Promise<ToolSet> {
  overrideSettingsForTest({ tools: { genericReadVerbs: true } });
  const rec = createRecorder(opts.calls, opts.resultFor);
  const skipped: string[] = [];
  const skip = (name: string): void => {
    skipped.push(name);
    opts.onSkip?.(name);
  };
  const set: Record<string, ToolSet[string]> = {
    no_reply: rec("no_reply", noReplyTool as MountableEntry),
    update_status: rec("update_status", updateStatusTool as MountableEntry),
    stand_down: rec("stand_down", standDownTool as MountableEntry),
  };
  if (opts.allowNoReply) {
    const entry = await tryReplyEntryForSeat(opts.ctx);
    if (entry !== null) set.reply = rec("reply", entry);
    else skip("reply");
  } else {
    set.reply = rec("reply", await replyEntryForSeat(opts.ctx));
  }
  for (const [name, mod] of [
    ["react", reactDynamic],
    ["spawn_thread_session", spawnThreadSessionDynamic],
    ["read_channel", readChannelDynamic],
    ["read_thread", readThreadDynamic],
    ["edit_reply", editReplyDynamic],
    ["stop_task", stopTaskDynamic],
    ["spawn_task", spawnTaskDynamic],
    ["complete_thread", completeThreadDynamic],
    ["set_dm_delivery", setDmDeliveryDynamic],
  ] as const) {
    const entry = await resolveDynamicEntry(mod, opts.ctx);
    if (entry !== null) set[name] = rec(name, entry);
    else skip(name);
  }
  const agentMod = await eveFrameworkTool("agent.js");
  set.agent = rec("agent", agentMod.AGENT_TOOL_DEFINITION as MountableEntry);
  const askMod = await eveFrameworkTool("ask-question.js");
  set.ask_question = rec("ask_question", askMod.ASK_QUESTION_TOOL_DEFINITION as MountableEntry);
  const todoMod = await eveFrameworkTool("todo.js");
  set.todo = rec("todo", todoMod.TODO_TOOL_DEFINITION as MountableEntry);
  const taskMod = await eveFrameworkTool("tasks.js");
  for (const def of taskMod.TASK_TOOL_DEFINITIONS as readonly (MountableEntry & { readonly name: string })[]) {
    if (def.name === "task_cancel") set[def.name] = rec(def.name, def);
  }
  const accountedFor = new Set([...Object.keys(set), ...skipped]);
  const unaccounted = [...LEAN_SEAT_TOOLS].filter((name) => !accountedFor.has(name));
  if (unaccounted.length > 0) {
    throw new Error(
      `buildLeanSeatToolset: LEAN_SEAT_TOOLS grew name(s) this builder never resolves: ${unaccounted.join(", ")} — add a mount/skip arm above (see the OPE-1052 doc comment)`,
    );
  }
  return set as ToolSet;
}
