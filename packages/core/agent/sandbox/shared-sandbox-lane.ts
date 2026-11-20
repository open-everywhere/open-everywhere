/**
 * One lane per shared sandbox for the host's own sandbox calls.
 *
 * A work session's subagent children share the work session's sandbox. Each child's hooks open
 * their own handle on it, so two children that end their turns together call `run` on one sandbox
 * at the same moment. On the in-process just-bash backend, one of two such overlapping calls can
 * never return. The child's turn step then never ends, eve never settles its `agent` call, and the
 * job's result never reaches the person. The cause is in just-bash, and it reaches past the hooks:
 * any two overlapping just-bash commands on one sandbox root can trip it. `just-bash-exec-lane.ts`
 * holds the cause and the per-root lane that runs every command on that backend one at a time, up to
 * its 10-second wait ceiling (see that file for the overlap that remains).
 *
 * The lane makes the host's own calls on one shared sandbox run one at a time, in the order they
 * arrive. It keys on the session that owns the sandbox: a child's delegation root, which eve names
 * in `session.parent.rootSessionId`, or the session itself when it owns its sandbox. A call waits
 * for the call before it at most `SANDBOX_LANE_WAIT_CEILING_MS`. A call that never returns then
 * holds the lane for that long only, and later calls run as they did before the lane.
 *
 * The lane covers the calls that go through a sandbox `inLaneSandbox` wrapped: today the memory
 * hook's calls and the egress hook's status publish and read. It does not cover the egress hook's
 * `setNetworkPolicy`, or a model's own tool calls on the sandbox.
 */

export const SANDBOX_LANE_WAIT_CEILING_MS = 30_000;

/** The sandbox methods the lane runs one at a time. Each returns a promise. */
const LANED_METHODS: ReadonlySet<PropertyKey> = new Set(["run", "readTextFile", "writeTextFile", "readFile", "writeFile", "removePath"]);

const tails = new Map<string, Promise<void>>();

interface LaneContext {
  readonly session?: { readonly id?: unknown; readonly parent?: { readonly rootSessionId?: unknown; readonly sessionId?: unknown } | null } | null;
}

function nonBlank(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The session that owns the sandbox this context's hooks reach, or `undefined` when none is named. */
export function sandboxLaneKey(ctx: unknown): string | undefined {
  try {
    const session = (ctx as LaneContext | null | undefined)?.session;
    const parent = session?.parent ?? undefined;
    return nonBlank(parent?.rootSessionId) ?? nonBlank(parent?.sessionId) ?? nonBlank(session?.id);
  } catch {
    return undefined;
  }
}

function waitAtMost(prior: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    prior,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Runs `work` in the lane `key` names: after every earlier call in that lane, or after the ceiling. */
export async function inSandboxLane<T>(key: string | undefined, work: () => Promise<T>, ceilingMs: number = SANDBOX_LANE_WAIT_CEILING_MS): Promise<T> {
  if (key === undefined) return await work();
  const prior = tails.get(key) ?? Promise.resolve();
  const turn = waitAtMost(prior, ceilingMs).then(work);
  const tail = turn.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return await turn;
}

/**
 * The same sandbox, with its file and command calls run in the lane `key` names. Every other
 * property reads through unchanged. A `null` or non-object sandbox comes back as it is.
 */
export function inLaneSandbox<S>(key: string | undefined, sandbox: S): S {
  if (key === undefined || sandbox === null || typeof sandbox !== "object") return sandbox;
  return new Proxy(sandbox as unknown as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (!LANED_METHODS.has(prop) || typeof value !== "function") return value;
      return (...args: unknown[]) => inSandboxLane(key, async () => await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
    },
  }) as unknown as S;
}

/** Test-only: how many lanes hold a call now. */
export function sandboxLanesHeldForTest(): number {
  return tails.size;
}
