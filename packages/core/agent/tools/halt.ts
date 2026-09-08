import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { appendAudit } from "../audit/audit.js";
import { orgWideWhere, whereFromScope } from "../approvals/actions.js";
import { haltAddressFields } from "../access/halt.js";
import { bindFrom } from "../identity/binding.js";
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
    `work, no connector calls, no borrowed credentials, no outbound network access. I can still read ` +
    `and reply here. An admin lifts it with \`resume\`.`
  );
}

export default defineTool({
  description:
    "STOP EVERYTHING CONSEQUENTIAL, NOW — the break-glass halt. Use it the moment someone in the conversation asks you to stop, halt, freeze, or pull the plug, or when you have good reason to believe something is going wrong. It takes effect immediately and needs no approval: nothing gated runs, no routine fires, no connector or credential is spendable, and no outbound fetch is made, until an admin runs `resume`. It does NOT silence you — you can still read and answer here. Prefer it over asking whether you should: stopping is reversible, and the thing you would be asking permission to stop is not.",
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
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const p = resolvePartition(ctx);
    const scope = input.scope ?? "org";
    const address = chatHaltAddress(scope, p.surfaceKey);
    const setBy = principalIdOf(ctx);
    await getOperationalStore().setHalt(p.org, address, ...(setBy ? [{ setBy }] : []));
    await appendAudit({
      ...(address.orgWide ? orgWideWhere(p.org) : whereFromScope(p.org, address.scopeKey)),
      ...(setBy ? { principalId: setBy } : {}),
      action: "admin.halt.set",
      detail: { ...haltAddressFields(address), door: "chat", platform: bindFrom(ctx).platform },
    }).catch(() => undefined);
    return { halted: true, scope, message: haltConfirmation(scope) };
  },
});
