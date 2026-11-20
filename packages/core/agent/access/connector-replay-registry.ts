/**
 * The approved-card replay seam for the OE connector tools (`connections/connector-tools.ts`).
 * A connector tool whose input names an approved card asks the registered resolver for the card's
 * stored input, runs it, then asks the registered settler to clear it. The resolver and the
 * settler live in `connections/connector-replay.ts`, which registers them at module load, so this
 * module holds no store and no identity import.
 */

export type ConnectorReplayResolver = (callId: unknown, executeInput: unknown) => Promise<Record<string, unknown>>;

let replayResolver: ConnectorReplayResolver | undefined;

export function registerConnectorReplayResolver(resolver: ConnectorReplayResolver): void {
  replayResolver = resolver;
}

/** The card's stored call. It throws when no resolver is loaded, so a replay never runs the placeholder. */
export async function resolveConnectorReplay(callId: unknown, executeInput: unknown): Promise<Record<string, unknown>> {
  if (replayResolver === undefined) throw new Error("The replay of an approved card was refused, because no replay resolver is loaded in this process. Nothing ran.");
  return replayResolver(callId, executeInput);
}

export type ConnectorReplaySettler = (executeInput: unknown) => Promise<void>;

let replaySettler: ConnectorReplaySettler | undefined;

export function registerConnectorReplaySettler(settler: ConnectorReplaySettler): void {
  replaySettler = settler;
}

export async function settleConnectorReplay(executeInput: unknown): Promise<void> {
  try {
    await replaySettler?.(executeInput);
  } catch {
  }
}
