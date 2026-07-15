import { appendAudit } from "./audit.js";
import type { WindowGrain } from "../identity/binding.js";

export async function auditWindowToolGate(input: {
  readonly org: string;
  readonly domain: string;
  readonly grain: WindowGrain;
  readonly withheld: readonly string[];
  readonly wakeId?: string | null;
  readonly sessionId?: string | null;
}): Promise<void> {
  if (input.withheld.length === 0) return;
  await appendAudit({
    org: input.org,
    platform: "unified",
    workspace: input.domain,
    action: "turn.tool_gated",
    detail: {
      grain: input.grain,
      withheld: [...input.withheld],
      withheldCount: input.withheld.length,
      wakeId: input.wakeId ?? null,
      sessionId: input.sessionId ?? null,
    },
  });
}
