import { defineHook, type HookContext } from "eve/hooks";
import { OE_SPAWN_TAINTED_ATTR } from "../channels/unified.js";
import { markUntrustedIngestedThisTurn } from "../access/taint-signal.js";

function seedIfSpawnTainted(ctx: HookContext): void {
  try {
    const attrs = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } }).session?.auth?.current?.attributes;
    const v = attrs?.[OE_SPAWN_TAINTED_ATTR];
    if (v === "true" || v === true) markUntrustedIngestedThisTurn();
  } catch {
  }
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => seedIfSpawnTainted(ctx),
  },
});
