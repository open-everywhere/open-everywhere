import { defineSandboxProvider } from "eve/sandbox/provider";
import { JustBashSandbox } from "eve/sandbox/just-bash";

/**
 * One lane per sandbox root for every command on the in-process just-bash sandbox backend.
 *
 * just-bash runs a "defense-in-depth" box during each command. The box is one object for the whole
 * process. It replaces `Promise.prototype.then`, and it ties each callback that a command registers
 * to that command's execution. When the callback fires after its execution has ended, the box skips
 * it. Two commands on one sandbox root that each evaluate a redirection (`2>/dev/null`, `> file`) a
 * few milliseconds apart trip this: the box records a `promise_then_after_deactivate` violation, and
 * the second command never returns. After that, every later command with a redirection on that root
 * never returns. This holds for two commands on one sandbox and on two sandboxes over one root, which
 * is what a work session's children share. Commands on two different roots, a command with no
 * redirection, and two commands that do not overlap always return. Load widens each command's
 * window, so the overlap is more likely on a busy host.
 *
 * The lane runs each `spawn` on a just-bash connection after the command before it on the same root
 * has ended, in the order the spawns arrive. It covers every command on a just-bash sandbox
 * connection: eve's own commands, the host's hooks, and a model's tool calls. The key is the session
 * root eve records in the session state (`rootPath`). A template build gets a lane of its own.
 *
 * A spawn waits for the command before it at most `JUST_BASH_EXEC_LANE_CEILING_MS`. So a long command
 * (an install, a build) delays a later command on its root for that long only. After that wait the two
 * commands overlap as they did before the lane, and the hazard is back for that pair if both evaluate a
 * redirection within milliseconds.
 *
 * One pair never gets the ceiling: eve's bash tool and its own job. The tool starts each command as a
 * job with a directory under `/tmp/.eve/jobs/`. When the command outlives the tool's yield, the tool
 * claims the job with a second command on the same root. When the tool call is aborted, it cancels the
 * job with a second command too. Both second commands name the job's directory, and both evaluate a
 * redirection. So a spawn whose command's FIRST named job directory belongs to an earlier command that
 * has not ended waits for that command to end, with no ceiling (`eveJobDirectoryOf`). eve's own launch
 * wrapper names a new job directory first, so a model command that reads a running job's files keys on
 * its own job and keeps the ceiling. On just-bash the claim
 * finds no job to claim (the launcher that backgrounds a job does not run there, because just-bash
 * cannot run `kill`), so eve's tool then
 * waits for the job anyway: the wait changes when the claim runs, not what the tool returns. The cancel
 * waits for the job too, and just-bash ends an aborted job at once.
 *
 * File reads, writes and removals do not start a just-bash command, so they do not wait in the lane.
 * Opening a sandbox does not start one either. The routine event filter (`routines/jq-filter.ts`) runs
 * its own just-bash `Bash` outside any sandbox root and evaluates no redirection, so it is outside
 * the lane.
 */

export const JUST_BASH_EXEC_LANE_CEILING_MS = 10_000;

/** The `Symbol.for` key under which eve keeps a sandbox environment's provider runtime. */
export const EVE_PROVIDER_RUNTIME_KEY = Symbol.for("eve.sandbox-provider-runtime");

/** Marks an implementation that `inExecLaneImplementation` returned. */
export const EXEC_LANED: unique symbol = Symbol.for("open-everywhere.just-bash-exec-laned");

/** The lane key when the session state names no root. */
export const UNKEYED_ROOT = "<no-root>";

/** The directory eve's bash tool gives one job, as its commands name it. */
const EVE_JOB_DIRECTORY = /\/tmp\/\.eve\/jobs\/[A-Za-z0-9_-]+/;

/**
 * The first eve bash-tool job directory a command names, or `undefined`. eve's launch command names
 * its own new job directory before the model's command text, so a model command that reads an older
 * job's files keys on its own job, not on the older one.
 */
export function eveJobDirectoryOf(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  return EVE_JOB_DIRECTORY.exec(command)?.[0];
}

export interface ExecLane {
  /**
   * Waits for the command before this one (at most the ceiling), then returns the release for this one.
   * With `job`, it also waits, with no ceiling, for the earlier command that named the same job and has
   * not ended. A command that names a job no earlier command holds becomes that job's holder.
   */
  acquire(job?: string): Promise<() => void>;
  /** How many spawns have started and not yet released. */
  held(): number;
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

export function createExecLane(ceilingMs: number = JUST_BASH_EXEC_LANE_CEILING_MS): ExecLane {
  let tail: Promise<void> = Promise.resolve();
  let held = 0;
  const jobs = new Map<string, Promise<void>>();
  return {
    async acquire(job?: string) {
      const prior = tail;
      let done!: () => void;
      const mine = new Promise<void>((resolve) => {
        done = resolve;
      });
      tail = mine;
      const holder = job === undefined ? undefined : jobs.get(job);
      if (job !== undefined && holder === undefined) {
        jobs.set(job, mine);
        void mine.then(() => {
          if (jobs.get(job) === mine) jobs.delete(job);
        });
      }
      await Promise.all([waitAtMost(prior, ceilingMs), holder]);
      held += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held -= 1;
        done();
      };
    },
    held: () => held,
  };
}

export interface ExecLanes {
  /** The lane of one sandbox root. */
  forRoot(root: string): ExecLane;
  /** Drops the lane of a root whose session has ended. */
  forget(root: string): void;
  /** How many roots have a lane now. */
  size(): number;
}

export function createExecLanes(ceilingMs: number = JUST_BASH_EXEC_LANE_CEILING_MS): ExecLanes {
  const lanes = new Map<string, ExecLane>();
  return {
    forRoot(root) {
      let lane = lanes.get(root);
      if (lane === undefined) {
        lane = createExecLane(ceilingMs);
        lanes.set(root, lane);
      }
      return lane;
    },
    forget(root) {
      lanes.delete(root);
    },
    size: () => lanes.size,
  };
}

/** The lanes every just-bash connection in this process uses. */
const JUST_BASH_EXEC_LANES: ExecLanes = createExecLanes();

interface SpawnedProcess {
  wait(): Promise<unknown>;
}

/**
 * The same connection, with `spawn` run in `lane`. The lane holds until the spawned process's
 * `wait()` settles. A spawn whose command names an eve job directory acquires the lane for that job.
 * Every other property reads through unchanged.
 */
export function inExecLane<C extends object>(connection: C, lane: ExecLane): C {
  return new Proxy(connection, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== "spawn" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const release = await lane.acquire(eveJobDirectoryOf((args[0] as { command?: unknown } | undefined)?.command));
        let proc: SpawnedProcess;
        try {
          proc = await (value as (...a: unknown[]) => Promise<SpawnedProcess>).apply(target, args);
        } catch (err) {
          release();
          throw err;
        }
        try {
          void proc.wait().then(release, release);
        } catch {
          release();
        }
        return proc;
      };
    },
  });
}

interface ProviderImplementation {
  prepare(ctx: object): Promise<unknown>;
  start(ctx: unknown, options: unknown, artifact: unknown): Promise<{ readonly connection: object; readonly state: unknown }>;
  resume(ctx: unknown, artifact: unknown, state: unknown): Promise<object>;
  onSessionEnd(ctx: unknown, state: unknown, options: unknown): Promise<void>;
}

interface ProviderRuntime {
  readonly implementation: ProviderImplementation;
  readonly prepare: unknown;
  readonly providerName: string;
  readonly stateProtocolVersion: number;
}

/** The sandbox root a just-bash session state names, or `UNKEYED_ROOT`. */
export function rootOfState(state: unknown): string {
  const root = (state as { rootPath?: unknown } | null | undefined)?.rootPath;
  return typeof root === "string" && root.length > 0 ? root : UNKEYED_ROOT;
}

/**
 * The provider implementation with every connection it opens put in its root's lane: the session
 * connections from `start` and `resume`, and the connection `prepare` hands to `populate`.
 */
export function inExecLaneImplementation<I extends ProviderImplementation>(
  implementation: I,
  lanes: ExecLanes = JUST_BASH_EXEC_LANES,
): Omit<I, keyof ProviderImplementation> & ProviderImplementation & { readonly [EXEC_LANED]: true } {
  return {
    ...implementation,
    [EXEC_LANED]: true as const,
    async prepare(ctx: object) {
      const lane = createExecLane();
      const laned = new Proxy(ctx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (prop !== "populate" || typeof value !== "function") return value;
          return async (connection: object, ...rest: unknown[]) =>
            await (value as (...a: unknown[]) => Promise<unknown>).apply(target, [inExecLane(connection, lane), ...rest]);
        },
      });
      return await implementation.prepare(laned);
    },
    async start(ctx: unknown, options: unknown, artifact: unknown) {
      const started = await implementation.start(ctx, options, artifact);
      return { ...started, connection: inExecLane(started.connection, lanes.forRoot(rootOfState(started.state))) };
    },
    async resume(ctx: unknown, artifact: unknown, state: unknown) {
      return inExecLane(await implementation.resume(ctx, artifact, state), lanes.forRoot(rootOfState(state)));
    },
    async onSessionEnd(ctx: unknown, state: unknown, options: unknown) {
      try {
        await implementation.onSessionEnd(ctx, state, options);
      } finally {
        if (state !== null && state !== undefined) lanes.forget(rootOfState(state));
      }
    },
  };
}

/**
 * The provider runtime of an eve sandbox environment. It throws when the environment carries none,
 * so a change to eve's environment shape fails at boot instead of leaving the lane unwired.
 */
export function providerRuntimeOf(environment: object): ProviderRuntime {
  const runtime = (environment as Record<symbol, unknown>)[EVE_PROVIDER_RUNTIME_KEY] as Partial<ProviderRuntime> | undefined;
  const impl = runtime?.implementation;
  if (
    runtime === undefined ||
    impl === undefined ||
    typeof impl.prepare !== "function" ||
    typeof impl.start !== "function" ||
    typeof impl.resume !== "function" ||
    typeof impl.onSessionEnd !== "function" ||
    typeof runtime.providerName !== "string" ||
    typeof runtime.stateProtocolVersion !== "number"
  ) {
    throw new Error(
      "[open-everywhere:sandbox] the just-bash sandbox environment carries no eve provider runtime, so its command lane cannot be wired. " +
        "eve's sandbox environment shape changed: re-check `Symbol.for(\"eve.sandbox-provider-runtime\")`.",
    );
  }
  return runtime as ProviderRuntime;
}

/** `environment` rebuilt with the same provider name and state protocol, and its connections laned. */
export function inExecLaneEnvironment<E extends object>(environment: E, lanes: ExecLanes = JUST_BASH_EXEC_LANES): E {
  const runtime = providerRuntimeOf(environment);
  const implementation = inExecLaneImplementation(runtime.implementation, lanes);
  const provider = defineSandboxProvider({
    name: runtime.providerName,
    stateProtocolVersion: runtime.stateProtocolVersion,
    environment: () => implementation as never,
  });
  return provider.environment({}) as unknown as E;
}

/** eve's just-bash environment, with every command on one sandbox root run one at a time. */
export function justBashEnvironment(): ReturnType<typeof JustBashSandbox.environment> {
  return inExecLaneEnvironment(JustBashSandbox.environment({}));
}
