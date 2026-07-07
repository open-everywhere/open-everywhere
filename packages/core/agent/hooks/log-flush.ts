import { defineHook } from "eve/hooks";
import { buildRecord, enqueue, flushLogShip } from "../observability/ship.js";

function recordFailure(kind: "turn" | "session", data: { code?: string; message?: string; details?: unknown }): void {
  enqueue(
    buildRecord("error", "eve", `${kind}.failed: ${data.message ?? "(no message)"}`, {
      fields: {
        failureKind: kind,
        code: data.code,
        details: data.details,
      },
    }),
  );
}

export default defineHook({
  events: {
    "turn.completed": async () => flushLogShip(),
    "turn.failed": async (event) => {
      recordFailure("turn", event.data ?? {});
      await flushLogShip();
    },
    "session.completed": async () => flushLogShip(),
    "session.failed": async (event) => {
      recordFailure("session", event.data ?? {});
      await flushLogShip();
    },
  },
});
