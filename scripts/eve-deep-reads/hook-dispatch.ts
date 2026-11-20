import { EveDeepReadError, loadEveInternalExports, readEveInternalSource } from "./load.js";

/**
 * Deep read of `eve/dist/src/execution/publish-session-events.js`: eve's session-event publisher. It
 * writes a step's lines to the session stream, and it runs the `defineHook` handlers on them.
 *
 * `scripts/eve-hook-replay-test.ts` drives this publisher on a retried step, from the step mark
 * (`enterSessionStep`) through the restore of the step input (`restoreSessionStep`) and the read of the
 * interrupted lines (`readOrphanedLines`) to the hook dispatch. eve's public surface gives no way to drive a step retry, so the test reads eve's internals on
 * purpose. The publisher needs a context, its keys, a host route, a session line store and a hook
 * definition, so this module also loads those from their own files. Each load fails by file and export
 * name.
 */
export const EVE_HOOK_DISPATCH_FILE = "execution/publish-session-events.js";

/** The other eve files that the publisher needs to run outside a workflow step. */
export const EVE_HOOK_DISPATCH_SUPPORT_FILES = {
  keys: "context/keys.js",
  runtimeKeys: "runtime/sessions/runtime-context-keys.js",
  hosts: "execution/hosts.js",
  hooks: "definitions/hooks.js",
  stepState: "execution/session/step-state-delta.js",
  dispatch: "execution/coordination-dispatch-step.js",
} as const;

const OWNER = "scripts/eve-deep-reads/hook-dispatch.ts";

/** A context key, as eve's `ContextContainer` reads it. */
export interface EveContextKey {
  readonly name: string;
}

/** The part of eve's `ContextContainer` the replay test uses. */
export interface EveContext {
  set(key: EveContextKey, value: unknown): unknown;
}

/** The session line store that eve's step reads the interrupted lines from. */
export interface EveSessionLineStore {
  tail(sessionId: string): Promise<number>;
  readable(sessionId: string, start: number): ReadableStream<Uint8Array>;
  assertReadable(sessionId: string): Promise<void>;
}

/** A host route. eve reads the step attempt from the first route that gives one. */
export interface EveHostRoute {
  readonly name: string;
  stepAttempt(): number | undefined;
}

/** The eve hook definition that `hookDefinition` builds from a hook module's `events`. */
export interface EveHookDefinition {
  readonly id: string;
}

export type EveHookHandler = (event: { readonly type: string; readonly data: Record<string, unknown> }, ctx: { readonly position?: { readonly line?: number } }) => Promise<void>;

/** A step input after `restoreSessionStep`: the context, the durable session, the stream and the retry mark. */
export interface EveRestoredStep {
  readonly ctx: EveContext;
  readonly durableSession: { readonly sessionId: string; readonly state: Record<string, unknown> };
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly rerun: boolean;
}

export interface EveHookDispatch {
  readonly AuthKey: EveContextKey;
  readonly SessionIdKey: EveContextKey;
  readonly ChannelKey: EveContextKey;
  readonly SessionAgentKey: EveContextKey;
  /** Marks a step input as retried when the host's step attempt is above 1. */
  readonly enterSessionStep: <T extends Record<string, unknown>>(input: T) => T & { readonly rerun: boolean };
  /**
   * Turns a serialized step input into a live one. `commitSessionStep` calls it for a step with no live
   * context whose transitions change something.
   */
  readonly restoreSessionStep: (step: Record<string, unknown>) => Promise<EveRestoredStep>;
  /** Publishes one step's facts: it reads the interrupted lines on a rerun, writes the rest and runs the hooks. */
  readonly publishFromSessionStep: (
    step: EveRestoredStep,
    run: { readonly origin: "own"; publish(emit: (events: readonly unknown[]) => Promise<void>): Promise<void> },
  ) => Promise<unknown>;
  /**
   * The workflow step that publishes `task.started` and `call.started` for the calls a turn dispatched.
   * It runs `withSessionStateDelta` (the retry mark) and then `commitSessionStep`.
   */
  readonly publishDispatchedCallsStep: (input: Record<string, unknown>) => Promise<unknown>;
  readonly registerHost: (route: EveHostRoute) => () => void;
  readonly registerSessionLineStore: (sessionId: string, store: EveSessionLineStore) => () => void;
  readonly hookDefinition: (hook: { readonly slug: string; readonly logicalPath: string; readonly events: Record<string, EveHookHandler> }) => EveHookDefinition;
  /** The source of eve's step wrapper, which marks a retried step for every publishing step. */
  readonly stepStateSource: string;
  /** The source of eve's session-event publisher, for the pin on `commitSessionStep`'s hand-off. */
  readonly publisherSource: string;
}

async function load<const N extends string>(root: string, file: string, names: readonly N[]): Promise<Record<N, unknown>> {
  return loadEveInternalExports({ root, file, names, owner: OWNER });
}

/** Loads eve's session-event publisher and the pieces it needs. Throws {@link EveDeepReadError} on a moved read. */
export async function loadEveHookDispatch(root: string): Promise<EveHookDispatch> {
  const files = EVE_HOOK_DISPATCH_SUPPORT_FILES;
  const publisher = await load(root, EVE_HOOK_DISPATCH_FILE, ["publishFromSessionStep", "enterSessionStep", "restoreSessionStep"]);
  const keys = await load(root, files.keys, ["AuthKey", "SessionIdKey"]);
  const runtimeKeys = await load(root, files.runtimeKeys, ["ChannelKey", "SessionAgentKey"]);
  const hosts = await load(root, files.hosts, ["registerHost", "registerSessionLineStore"]);
  const hooks = await load(root, files.hooks, ["hookDefinition"]);
  const dispatch = await load(root, files.dispatch, ["publishDispatchedCallsStep"]);
  const stepStateSource = readEveInternalSource({ root, file: files.stepState, owner: OWNER });
  if (!stepStateSource.includes("enterSessionStep(")) {
    throw new EveDeepReadError({ file: files.stepState, missing: "its step wrapper no longer marks a retried step (enterSessionStep)", owner: OWNER });
  }
  return {
    AuthKey: keys["AuthKey"] as EveContextKey,
    SessionIdKey: keys["SessionIdKey"] as EveContextKey,
    ChannelKey: runtimeKeys["ChannelKey"] as EveContextKey,
    SessionAgentKey: runtimeKeys["SessionAgentKey"] as EveContextKey,
    enterSessionStep: publisher["enterSessionStep"] as EveHookDispatch["enterSessionStep"],
    restoreSessionStep: publisher["restoreSessionStep"] as EveHookDispatch["restoreSessionStep"],
    publishFromSessionStep: publisher["publishFromSessionStep"] as EveHookDispatch["publishFromSessionStep"],
    publishDispatchedCallsStep: dispatch["publishDispatchedCallsStep"] as EveHookDispatch["publishDispatchedCallsStep"],
    registerHost: hosts["registerHost"] as EveHookDispatch["registerHost"],
    registerSessionLineStore: hosts["registerSessionLineStore"] as EveHookDispatch["registerSessionLineStore"],
    hookDefinition: hooks["hookDefinition"] as EveHookDispatch["hookDefinition"],
    stepStateSource,
    publisherSource: readEveInternalSource({ root, file: EVE_HOOK_DISPATCH_FILE, owner: OWNER }),
  };
}
