import { defineHook, type HookContext } from "eve/hooks";
import { routineSilentStamped } from "../routines/routine.js";
import { clearSilentRoutineTurn, markSilentRoutineTurn } from "../routines/report.js";

function attrsOf(ctx: HookContext): Readonly<Record<string, string | readonly string[]>> | undefined {
  const c = ctx as unknown as {
    session?: {
      auth?: {
        current?: { attributes?: Readonly<Record<string, string | readonly string[]>> } | null;
        initiator?: { attributes?: Readonly<Record<string, string | readonly string[]>> } | null;
      };
    };
  };
  return c.session?.auth?.current?.attributes ?? c.session?.auth?.initiator?.attributes;
}

function classifyTurn(ctx: HookContext): void {
  clearSilentRoutineTurn();
  try {
    if (routineSilentStamped(attrsOf(ctx))) markSilentRoutineTurn();
  } catch {
  }
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => classifyTurn(ctx),
    "turn.completed": () => clearSilentRoutineTurn(),
    "turn.failed": () => clearSilentRoutineTurn(),
  },
});
