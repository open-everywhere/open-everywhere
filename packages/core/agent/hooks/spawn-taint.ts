import { defineHook, type HookContext } from "eve/hooks";
import { OE_SPAWN_TAINTED_ATTR } from "../channels/unified.js";
import { markUntrustedIngestedThisTurn, OE_TAINTED_FIRE_ATTR, OE_RESULT_TAINTED_ATTR } from "../access/taint-signal.js";

export const TAINT_SEED_ATTRS: readonly string[] = [OE_SPAWN_TAINTED_ATTR, OE_TAINTED_FIRE_ATTR, OE_RESULT_TAINTED_ATTR];

export function seedIfTainted(ctx: HookContext): void {
  try {
    const attrs = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } }).session?.auth?.current?.attributes;
    for (const name of TAINT_SEED_ATTRS) {
      const v = attrs?.[name];
      if (v === "true" || v === true) {
        markUntrustedIngestedThisTurn();
        return;
      }
    }
  } catch {
  }
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => seedIfTainted(ctx),
  },
});
