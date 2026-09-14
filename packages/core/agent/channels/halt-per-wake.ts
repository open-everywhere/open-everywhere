import type { BindableContext } from "../identity/binding.js";
import { haltScopeFor, resolveHalt, type HaltDeps, type HaltState } from "../access/halt.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { getOperationalStore } from "../operational/provider.js";
import type { PendingUnifiedWake } from "./unified-window.js";
import { wakeSurfaceKeyFromTargetJson, WAKE_TARGET_TTL_MS } from "./unified-window.js";

const MAX_ROOMS_READ = 20;

export type TurnHaltReach =
  | { readonly kind: "none" }
  | { readonly kind: "all"; readonly state: HaltState }
  | { readonly kind: "partial"; readonly state: HaltState; readonly haltedRooms: number; readonly totalRooms: number };

export interface TurnHaltReachDeps {
  readonly rows?: HaltDeps["rows"];
  readonly pendingWakes?: (org: string, windowToken: string, afterIso: string, limit: number) => Promise<readonly PendingUnifiedWake[]>;
}

export async function resolveTurnHaltReach(ctx: BindableContext, turnState: HaltState, org: string, deps: TurnHaltReachDeps = {}): Promise<TurnHaltReach> {
  const floor: TurnHaltReach = turnState.halted ? { kind: "all", state: turnState } : { kind: "none" };
  try {
    const windowToken = resolveOwnWindowToken(ctx);
    if (windowToken === undefined) return floor;
    const afterIso = new Date(Date.now() - WAKE_TARGET_TTL_MS).toISOString();
    let rows: readonly PendingUnifiedWake[];
    try {
      const list = deps.pendingWakes ?? ((o: string, t: string, a: string, l: number) => getOperationalStore().listPendingUnifiedWakes(o, t, a, l));
      rows = await list(org, windowToken, afterIso, MAX_ROOMS_READ);
    } catch {
      return floor;
    }
    const surfaceKeys = new Set<string>();
    for (const row of rows) {
      const key = wakeSurfaceKeyFromTargetJson(row.targetJson);
      if (key !== undefined) surfaceKeys.add(key);
    }
    if (surfaceKeys.size <= 1) return floor;
    let rowsOnce: HaltDeps["rows"] | undefined = deps.rows;
    if (rowsOnce === undefined) {
      try {
        const active = await getOperationalStore().activeHalts(org);
        rowsOnce = async () => active;
      } catch {
        return floor;
      }
    }
    let halted = 0;
    let covering: HaltState | undefined = turnState.halted ? turnState : undefined;
    for (const surfaceKey of surfaceKeys) {
      const state = await resolveHalt(haltScopeFor({ org, scopeKey: surfaceKey }), { rows: rowsOnce }).catch(
        (): HaltState => ({ halted: true, unreadable: "the halt state could not be read" }),
      );
      if (state.halted) {
        halted++;
        covering ??= state;
      }
    }
    if (halted === 0) return floor;
    if (covering === undefined) return floor;
    if (halted === surfaceKeys.size) return { kind: "all", state: covering };
    return { kind: "partial", state: covering, haltedRooms: halted, totalRooms: surfaceKeys.size };
  } catch {
    return floor;
  }
}

export function partialHaltPrefix(reach: TurnHaltReach): string | null {
  if (reach.kind !== "partial") return null;
  return (
    `**This pause does NOT cover every conversation you are holding open** — it covers ` +
    `${reach.haltedRooms} of the ${reach.totalRooms} with an unanswered message. So do not tell a room ` +
    `that work is paused unless the pause reaches that room: saying it where it is untrue stops work ` +
    `nobody stopped. The refusals themselves are decided per act, so a conversation the pause does not ` +
    `reach keeps working normally and you will not be refused in it.`
  );
}
