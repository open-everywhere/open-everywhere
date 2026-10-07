import { defineHook, type HookContext } from "eve/hooks";
import { resolvePartition } from "../memory/partition.js";
import { auditFireAttrsSeen } from "../routines/fire-carriage.js";
import { routineMarker } from "../routines/routine.js";
import { isWorkSessionContext } from "../access/work-session.js";
import { isScheduleOriginatedAuth, isSubagentChildContext, type BindableContext } from "../identity/binding.js";

interface AuthSlotContext {
  readonly session?: {
    readonly id?: unknown;
    readonly auth?: { readonly current?: unknown; readonly initiator?: unknown } | null;
  };
}

export function isFireCarriageTurn(ctx: HookContext): boolean {
  const bindable = ctx as unknown as BindableContext;
  if (isSubagentChildContext(bindable)) return false;
  const c = ctx as unknown as AuthSlotContext;
  const auth = (c.session?.auth?.current ?? c.session?.auth?.initiator ?? null) as
    | { authenticator?: unknown; principalId?: unknown; principalType?: unknown; attributes?: Record<string, string | readonly string[]> }
    | null;
  if (isScheduleOriginatedAuth(auth)) return true;
  return routineMarker(auth?.attributes) !== null && isWorkSessionContext(bindable);
}

async function auditCarriage(ctx: HookContext): Promise<void> {
  try {
    if (!isFireCarriageTurn(ctx)) return;
    const c = ctx as unknown as AuthSlotContext;
    const auth = (c.session?.auth?.current ?? c.session?.auth?.initiator ?? null) as { attributes?: Record<string, unknown> } | null;
    const p = resolvePartition(ctx as unknown as BindableContext);
    await auditFireAttrsSeen(
      { platform: p.platform, workspace: p.workspace, surface: p.surface },
      auth?.attributes,
      typeof c.session?.id === "string" ? c.session.id : undefined,
    );
  } catch {
  }
}

export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => {
      await auditCarriage(ctx);
    },
  },
});
