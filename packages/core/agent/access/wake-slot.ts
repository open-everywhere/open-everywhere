const EVE_CONTEXT_STORAGE_KEY = Symbol.for("eve.context-storage");

// eve 1.x keeps `{ context, values }` in its ALS, not the context container itself, so the
// container is the store's `context` field, never the store.
export function eveContextContainer(): unknown {
  const storage = (globalThis as Record<symbol, unknown>)[EVE_CONTEXT_STORAGE_KEY] as { getStore?: () => unknown } | undefined;
  if (typeof storage?.getStore !== "function") return undefined;
  const store = storage.getStore() as { context?: unknown } | undefined | null;
  return store === undefined || store === null ? undefined : store.context ?? undefined;
}

export function eveContextActive(): boolean | undefined {
  try {
    const storage = (globalThis as Record<symbol, unknown>)[EVE_CONTEXT_STORAGE_KEY] as { getStore?: () => unknown } | undefined;
    if (typeof storage?.getStore !== "function") return undefined;
    // Any live store counts as a context, even one whose `context` is undefined: the restricting
    // answer is the safe one there.
    return storage.getStore() !== undefined;
  } catch {
    return undefined;
  }
}

export class WakeSlotWriteError extends Error {
  readonly slot: string;
  constructor(slot: string, cause: unknown) {
    super(`open-everywhere: the per-wake slot "${slot}" could not be written inside an eve context (${String(cause).slice(0, 200)}). The wake fails closed rather than run on a stale or permissive posture.`);
    this.name = "WakeSlotWriteError";
    this.slot = slot;
  }
}

const surfaced = new Set<string>();

function surfaceOnce(slot: string, op: "read" | "write", err: unknown): void {
  const key = `${op}:${slot}`;
  if (surfaced.has(key)) return;
  surfaced.add(key);
  console.error(`[open-everywhere:wake-slot] ${op} of "${slot}" FAILED inside an eve context — failing closed: ${String(err).slice(0, 200)}`);
}

export function readWakeSlot<T>(slot: string, read: () => T, answers: { readonly contextless: T; readonly restricting: T }): T {
  try {
    return read();
  } catch (err) {
    if (eveContextActive() === false) return answers.contextless;
    surfaceOnce(slot, "read", err);
    return answers.restricting;
  }
}

export function writeWakeSlot(slot: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    if (eveContextActive() === false) return;
    surfaceOnce(slot, "write", err);
    throw new WakeSlotWriteError(slot, err);
  }
}
