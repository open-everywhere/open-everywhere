import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { appendAudit } from "../audit/audit.js";
import { orgWideWhere, whereFromScope } from "../approvals/actions.js";
import { haltAddressFields } from "../access/halt.js";
import { postHostNotice, REPLY_DEDUPE_SKIPPED_ID, resolveReplyTarget, type ReplyTarget } from "../channels/reply-post.js";
import { bindFrom, currentSessionId, currentWakeId, type BindableContext } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";
import type { HaltAddress } from "../operational/store.js";

export function chatHaltAddress(scope: "org" | "surface", surfaceKey: string): HaltAddress {
  return scope === "org" ? { orgWide: true } : { orgWide: false, level: "surface", scopeKey: surfaceKey };
}

export function haltConfirmation(scope: "org" | "surface"): string {
  const where = scope === "org" ? "everywhere in this deployment" : "in this conversation";
  return (
    `Halted ${where}. Nothing consequential will run now — no approvals, no scheduled or event-driven ` +
    `work, no borrowed credentials, and nothing fetched from the open web. I can still read, reply, ` +
    `post a file into this conversation, and keep what we say in memory, so ask me anything I can ` +
    `answer by reading. An admin lifts it with \`resume\`.`
  );
}

export function haltModelMessage(announced: boolean, scope: "org" | "surface"): string {
  return announced
    ? "The halt is on and this room has already been told, in the host's own words. Do not repeat the confirmation. Say in one line what you stopped and why."
    : `The halt is on, but the confirmation could NOT be posted here. Say this in your own reply, now: ${haltConfirmation(scope)}`;
}

export interface HaltAnnounceDeps {
  readonly resolveTarget?: (ctx: BindableContext) => ReplyTarget | null;
  readonly post?: (target: ReplyTarget, text: string) => Promise<string>;
}

export async function announceHalt(ctx: BindableContext, scope: "org" | "surface", deps: HaltAnnounceDeps = {}): Promise<boolean> {
  try {
    const target = (deps.resolveTarget ?? resolveReplyTarget)(ctx);
    if (target === null) return false;
    const id = await (deps.post ?? postHostNotice)(target, haltConfirmation(scope));
    return id !== REPLY_DEDUPE_SKIPPED_ID;
  } catch {
    return false;
  }
}

export default defineTool({
  description:
    "STOP EVERYTHING CONSEQUENTIAL, NOW — the break-glass halt, for the whole room or the whole deployment. It takes effect immediately and needs no approval: nothing gated runs, no routine fires, no borrowed credential is spendable, no tool from a connected integration is usable, the sandbox reaches no host, and `web_fetch` and `web_search` are withheld, until an admin runs `resume`. It does NOT stop reading: a halt pauses acts whose effect leaves the conversation, so you can still read, answer, delegate a read to a worker, post a file into this room, and keep what is said in memory. Pull it when someone asks you to halt, freeze, or pull the plug on EVERYTHING here, or when you have good reason to believe something is going wrong. 🔴 A REQUEST TO STOP ONE PIECE OF WORK IS NOT THIS VERB. \"stop that changelog one\", \"drop the PR task\", \"we're not doing that this release\" NAME something — a task, a thread, a topic — so cancel the named task with `task_cancel` and leave everything else running. A request to go quiet is `stand_down`. Read what the person named before you reach for this: the whole room is the default only when they named the whole room. When the ask really is everything, prefer it over asking whether you should: stopping everything is reversible, and the thing you would be asking permission to stop is not.",
  inputSchema: z.object({
    scope: z
      .enum(["org", "surface"])
      .default("org")
      .describe(
        'How far it reaches. "org" (the default) stops the whole deployment — the right answer for an incident. "surface" stops only this conversation. The address itself is resolved from this conversation; you never supply one.',
      ),
  }),
  outputSchema: z.object({
    halted: z.boolean(),
    scope: z.enum(["org", "surface"]),
    announced: z.boolean(),
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const p = resolvePartition(ctx);
    const scope = input.scope ?? "org";
    const address = chatHaltAddress(scope, p.surfaceKey);
    const setBy = principalIdOf(ctx);
    const wakeId = currentWakeId(ctx);
    const sessionId = currentSessionId(ctx);
    const setAt = new Date().toISOString();
    await getOperationalStore().setHalt(p.org, address, { ...(setBy ? { setBy } : {}), setAt, ...(wakeId ? { setRef: wakeId } : {}) });
    const announced = await announceHalt(ctx as BindableContext, scope);
    await appendAudit({
      ...(address.orgWide ? orgWideWhere(p.org) : whereFromScope(p.org, address.scopeKey)),
      ...(setBy ? { principalId: setBy } : {}),
      action: "admin.halt.set",
      detail: {
        ...haltAddressFields(address),
        door: "chat",
        platform: bindFrom(ctx).platform,
        announced,
        setAt,
        ...(wakeId ? { wakeId } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    }).catch(() => undefined);
    return { halted: true, scope, announced, message: haltModelMessage(announced, scope) };
  },
});
