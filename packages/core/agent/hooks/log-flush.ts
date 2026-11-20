import { defineHook } from "eve/hooks";
import { buildRecord, enqueue, flushLogShip } from "../observability/ship.js";
import { optional } from "./control-refusal.js";

function recordFailure(kind: "turn" | "session", error: { code?: string; message?: string } | undefined): void {
  enqueue(
    buildRecord("error", "eve", `${kind}.failed: ${error?.message ?? "(no message)"}`, {
      fields: {
        failureKind: kind,
        code: error?.code,
      },
    }),
  );
}

export default defineHook({
  events: {
    "turn.settled": optional("log-flush", async (event) => {
      if (event.data.outcome === "failed") recordFailure("turn", event.data.error);
      await flushLogShip();
    }),
    "session.ended": optional("log-flush", async (event) => {
      if (event.data.outcome === "failed") recordFailure("session", event.data.error);
      await flushLogShip();
    }),
  },
});
