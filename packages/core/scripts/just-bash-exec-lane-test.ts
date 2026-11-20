import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const {
  createExecLane,
  createExecLanes,
  inExecLane,
  inExecLaneEnvironment,
  inExecLaneImplementation,
  justBashEnvironment,
  providerRuntimeOf,
  rootOfState,
  EVE_PROVIDER_RUNTIME_KEY,
  EXEC_LANED,
  UNKEYED_ROOT,
  JUST_BASH_EXEC_LANE_CEILING_MS,
  eveJobDirectoryOf,
} = await import("../agent/sandbox/just-bash-exec-lane.js");

const PENDING = Symbol("pending");
const settledWithin = async <T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> =>
  await Promise.race([p, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms))]);

/**
 * Child mode: two real just-bash sandboxes, each as a connection with eve's spawn shape. Both start
 * a command with a redirection at the same moment, then the first runs one more. It prints one JSON
 * line: what each command returned, or "HANG".
 *   bare-one:  two sandboxes over ONE root, no lane.
 *   laned-one: the same, both connections in one lane.
 *   bare-two:  two sandboxes over TWO roots, no lane.
 */
async function child(mode: string): Promise<void> {
  const jb = await import("just-bash");
  const newRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "oe-jb-exec-lane-"));
    mkdirSync(join(root, "fs"));
    return root;
  };
  let violations = 0;
  const onViolation = (): void => {
    violations += 1;
  };
  const connect = async (root: string): Promise<{ spawn(o: { command: string }): Promise<{ wait(): Promise<number>; output(): Promise<string> }> }> => {
    const fs = new jb.ReadWriteFs({ allowSymlinks: true, root: join(root, "fs") });
    await fs.mkdir("/workspace", { recursive: true });
    const sandbox = await jb.Sandbox.create({ cwd: "/workspace", fs, defenseInDepth: { enabled: true, onViolation } });
    return {
      async spawn(o) {
        const command = await sandbox.runCommand({ cmd: "eval", args: [o.command], detached: true });
        const out = (async () => {
          let s = "";
          for await (const line of command.logs()) s += line.data;
          return s.trim();
        })();
        let waited: Promise<number> | undefined;
        return { wait: () => (waited ??= command.wait().then((r) => r.exitCode)), output: () => out };
      },
    };
  };
  const rootA = newRoot();
  const rootB = mode === "bare-two" ? newRoot() : rootA;
  const lane = createExecLane();
  const a = mode === "laned-one" ? inExecLane(await connect(rootA), lane) : await connect(rootA);
  const b = mode === "laned-one" ? inExecLane(await connect(rootB), lane) : await connect(rootB);
  const run = async (c: typeof a, cmd: string): Promise<string> => {
    const proc = await c.spawn({ command: cmd });
    await proc.wait();
    return await proc.output();
  };
  const keep = setInterval(() => undefined, 1000);
  const timed = async (p: Promise<string>): Promise<string> => {
    const got = await settledWithin(p, 4000);
    return got === PENDING ? "HANG" : got;
  };
  const pair = await Promise.all([timed(run(a, "true 2>/dev/null; echo A")), timed(run(b, "true 2>/dev/null; echo B"))]);
  const after = await timed(run(a, "true 2>/dev/null; echo after"));
  clearInterval(keep);
  process.stdout.write(`${JSON.stringify({ pair, after, violations })}\n`);
  process.exit(0);
}

const childAt = process.argv.indexOf("--child");
if (childAt !== -1) {
  await child(process.argv[childAt + 1] ?? "bare-one");
} else {
  let n = 0;
  const ok = (cond: boolean, label: string): void => {
    assert.ok(cond, label);
    n++;
  };
  const eq = (a: unknown, b: unknown, label: string): void => {
    assert.deepStrictEqual(a, b, label);
    n++;
  };

  const self = fileURLToPath(import.meta.url);
  const coreRoot = dirname(dirname(self));
  const runChild = (mode: string): { pair: string[]; after: string; violations: number } => {
    const r = spawnSync(process.execPath, ["--import", "tsx", self, "--child", mode], { cwd: coreRoot, encoding: "utf8", timeout: 60_000 });
    const line = r.stdout.split("\n").find((l) => l.startsWith("{"));
    assert.ok(line !== undefined, `child ${mode} printed no result (status ${String(r.status)}): ${r.stderr.slice(0, 800)}`);
    return JSON.parse(line) as { pair: string[]; after: string; violations: number };
  };

  // 1. The hazard, on real just-bash: two overlapping commands with a redirection on one root.
  //    The negative control proves the bare pair hangs on the installed just-bash, so the laned
  //    result means something. The two-root case pins the lane's per-root scope.
  const bare = runChild("bare-one");
  eq(bare.pair[0], "A", "bare: the first command returns");
  eq(bare.pair[1], "HANG", "🔴 negative control: on the installed just-bash, the overlapping second command on one root no longer hangs — re-check the hazard and the lane's reason to exist");
  eq(bare.after, "HANG", "bare: after the overlap, a later command with a redirection on that root never returns");
  ok(bare.violations >= 1, "bare: just-bash records the promise_then_after_deactivate violation");

  const laned = runChild("laned-one");
  eq(laned.pair, ["A", "B"], "🔴 in the lane, both overlapping commands return");
  eq(laned.after, "after", "🔴 in the lane, a later command with a redirection still returns");
  eq(laned.violations, 0, "in the lane, just-bash records no violation");

  const twoRoots = runChild("bare-two");
  eq(twoRoots.pair, ["A", "B"], "two roots, no lane: both return — if this hangs, the hazard is process-wide and one lane per root is too narrow");
  eq(twoRoots.after, "after", "two roots, no lane: a later command still returns");

  // 2. The lane: one command at a time, in arrival order; the release follows the process's wait().
  {
    const lane = createExecLane(5_000);
    const log: string[] = [];
    const finish: Record<string, () => void> = {};
    const conn = {
      label: "conn",
      async spawn(o: { command: string }) {
        log.push(`start ${o.command}`);
        const done = new Promise<number>((resolve) => {
          finish[o.command] = () => {
            log.push(`end ${o.command}`);
            resolve(0);
          };
        });
        return { wait: () => done };
      },
    };
    const laned2 = inExecLane(conn, lane);
    eq(laned2.label, "conn", "a non-spawn property reads through");
    const p1 = laned2.spawn({ command: "one" });
    const p2 = laned2.spawn({ command: "two" });
    const p3 = laned2.spawn({ command: "three" });
    await p1;
    await new Promise((r) => setTimeout(r, 30));
    eq(log, ["start one"], "the second spawn waits while the first command runs");
    eq(lane.held(), 1, "one command holds the lane");
    finish.one?.();
    await p2;
    await new Promise((r) => setTimeout(r, 30));
    eq(log, ["start one", "end one", "start two"], "the second starts only after the first ends, and the third still waits");
    finish.two?.();
    await p3;
    finish.three?.();
    await new Promise((r) => setTimeout(r, 10));
    eq(log, ["start one", "end one", "start two", "end two", "start three", "end three"], "the spawns run in arrival order");
    eq(lane.held(), 0, "the lane is empty when every command has ended");
  }

  // 3. The ceiling: a command that never ends delays the next for the ceiling only.
  {
    const lane = createExecLane(60);
    const conn = { spawn: async () => ({ wait: () => new Promise<number>(() => undefined) }) };
    const laned3 = inExecLane(conn, lane);
    await laned3.spawn();
    const t0 = Date.now();
    const second = await settledWithin(laned3.spawn(), 2_000);
    ok(second !== PENDING, "🔴 a spawn behind a command that never ends still starts");
    ok(Date.now() - t0 >= 50, "it waits about the ceiling first");
  }

  // 4. A spawn that throws, and a wait that rejects, both release the lane.
  {
    const lane = createExecLane(5_000);
    let calls = 0;
    const conn = {
      async spawn() {
        calls += 1;
        if (calls === 1) throw new Error("spawn failed");
        if (calls === 2) return { wait: () => Promise.reject(new Error("wait failed")) };
        return { wait: () => Promise.resolve(0) };
      },
    };
    const laned4 = inExecLane(conn, lane);
    await assert.rejects(laned4.spawn(), /spawn failed/);
    const proc = await laned4.spawn();
    await assert.rejects(proc.wait(), /wait failed/);
    const third = await settledWithin(laned4.spawn(), 500);
    ok(third !== PENDING, "🔴 a failed spawn and a rejected wait each release the lane at once");
    await new Promise((r) => setTimeout(r, 10));
    eq(lane.held(), 0, "the third command ended, so the lane is empty");
  }

  // 5. The provider wiring: every connection the implementation opens is laned, keyed on its root.
  type Spawner = { spawn(): Promise<unknown> };
  const neverEnding = (label: string) => ({ label, spawn: async () => ({ wait: () => new Promise<number>(() => undefined) }) });
  const fakeImplementation = (ended: string[]) => ({
    toolSessions: true as const,
    async prepare(ctx: { populate(c: object): Promise<void>; storagePath: string }) {
      await ctx.populate(neverEnding("template"));
      return { templateKey: `k-${ctx.storagePath}` };
    },
    async start() {
      return { connection: neverEnding("started"), state: { rootPath: "/roots/one", version: 2 } };
    },
    async resume() {
      return neverEnding("resumed");
    },
    async onSessionEnd(_ctx: unknown, state: unknown) {
      ended.push(rootOfState(state));
    },
  });
  {
    const lanes = createExecLanes(5_000);
    const ended: string[] = [];
    const impl = fakeImplementation(ended);
    const wrapped = inExecLaneImplementation(impl, lanes);
    eq(wrapped.toolSessions, true, "the implementation's other members read through");
    eq((wrapped as unknown as Record<symbol, unknown>)[EXEC_LANED], true, "the wrapped implementation carries the laned mark");
    let populated: Spawner | undefined;
    const prepared = await wrapped.prepare({
      storagePath: "/store",
      async populate(c: object) {
        populated = c as Spawner;
      },
    });
    eq(prepared, { templateKey: "k-/store" }, "prepare's context and result read through");
    const started = await wrapped.start(undefined, undefined, undefined);
    eq(started.state, { rootPath: "/roots/one", version: 2 }, "start's state reads through");
    await (started.connection as Spawner).spawn();
    eq(lanes.forRoot("/roots/one").held(), 1, "🔴 a started connection's spawn takes its root's lane");
    const sameRoot = (await wrapped.resume(undefined, undefined, { rootPath: "/roots/one", version: 2 })) as Spawner;
    eq(await settledWithin(sameRoot.spawn(), 40), PENDING, "🔴 a resumed connection on the same root waits in that lane");
    const otherRoot = (await wrapped.resume(undefined, undefined, { rootPath: "/roots/two", version: 2 })) as Spawner;
    ok((await settledWithin(otherRoot.spawn(), 200)) !== PENDING, "a connection on another root does not wait");
    ok((await settledWithin(populated!.spawn(), 200)) !== PENDING, "the template connection has a lane of its own");
    eq(await settledWithin(populated!.spawn(), 40), PENDING, "🔴 the template connection's second spawn waits in that lane");
    const before = lanes.size();
    await wrapped.onSessionEnd(undefined, { rootPath: "/roots/two", version: 2 }, { reason: "completed" });
    eq(ended, ["/roots/two"], "onSessionEnd reaches the implementation");
    eq(lanes.size(), before - 1, "an ended session's lane is dropped");
    eq(rootOfState(null), UNKEYED_ROOT, "a state with no root keys the shared fallback lane");
  }

  // 6. The environment wiring, on a fake runtime and on the installed eve.
  {
    const lanes = createExecLanes(5_000);
    const ended: string[] = [];
    const fakeEnv = { [EVE_PROVIDER_RUNTIME_KEY]: { implementation: fakeImplementation(ended), prepare: undefined, providerName: "just-bash", stateProtocolVersion: 1 } };
    const rebuilt = inExecLaneEnvironment(fakeEnv, lanes);
    const runtime = providerRuntimeOf(rebuilt);
    eq([runtime.providerName, runtime.stateProtocolVersion], ["just-bash", 1], "the rebuilt environment keeps the provider name and state protocol");
    const started = await runtime.implementation.start(undefined, undefined, undefined);
    await (started.connection as Spawner).spawn();
    eq(lanes.forRoot("/roots/one").held(), 1, "🔴 a connection the rebuilt environment starts takes its root's lane");

    const { JustBashSandbox } = await import("eve/sandbox/just-bash");
    const raw = providerRuntimeOf(JustBashSandbox.environment({}));
    eq(raw.providerName, "just-bash", "🔴 the installed eve's just-bash environment carries its provider runtime");
    ok((raw.implementation as unknown as Record<symbol, unknown>)[EXEC_LANED] === undefined, "eve's own implementation is not laned");
    const app = providerRuntimeOf(justBashEnvironment());
    eq((app.implementation as unknown as Record<symbol, unknown>)[EXEC_LANED], true, "🔴 justBashEnvironment() hands eve a laned implementation");
    eq([app.providerName, app.stateProtocolVersion], [raw.providerName, raw.stateProtocolVersion], "🔴 justBashEnvironment() keeps eve's provider name and state protocol, so recorded sessions still resume");
    eq((app.implementation as unknown as { toolSessions?: unknown }).toolSessions, (raw.implementation as unknown as { toolSessions?: unknown }).toolSessions, "toolSessions reads through");
    assert.throws(() => providerRuntimeOf({}), /carries no eve provider runtime/);
    n++;
  }

  // 7. Reachability: both shipped sandbox files build the just-bash backend through the lane.
  {
    const repo = dirname(dirname(coreRoot));
    for (const rel of ["agent/sandbox/sandbox.ts", "packages/create/template/agent/sandbox/sandbox.ts"]) {
      const src = readFileSync(join(repo, rel), "utf8");
      ok(src.includes("justBashEnvironment()"), `🔴 ${rel} builds its just-bash environment with justBashEnvironment()`);
      ok(!src.includes("JustBashSandbox.environment("), `🔴 ${rel} opens no bare just-bash environment outside the lane`);
    }
  }

  // 8. A command that names an eve job waits for that job with no ceiling.
  {
    eq(eveJobDirectoryOf(`set -- '/tmp/.eve/jobs/ab12cd34' 'tail /tmp/.eve/jobs/00ff00ff/stdout'`), "/tmp/.eve/jobs/ab12cd34", "the first job directory a command names is its key");
    eq(eveJobDirectoryOf("echo hi"), undefined, "a command that names no job has no key");
    eq(eveJobDirectoryOf(undefined), undefined, "a spawn with no command text has no key");
    const lane = createExecLane(40);
    const conn = { spawn: async (_o: { command: string }) => ({ wait: () => new Promise<number>(() => undefined) }) };
    const laned8 = inExecLane(conn, lane);
    await laned8.spawn({ command: "launch '/tmp/.eve/jobs/aaaa1111'" });
    ok((await settledWithin(laned8.spawn({ command: "echo other" }), 1_000)) !== PENDING, "a command that names no job still starts after the ceiling");
    eq(await settledWithin(laned8.spawn({ command: "cd '/tmp/.eve/jobs/aaaa1111' 2>/dev/null" }), 400), PENDING, "🔴 a command that names a running job's directory waits past the ceiling for that job");
    ok((await settledWithin(laned8.spawn({ command: "launch '/tmp/.eve/jobs/bbbb2222'" }), 1_000)) !== PENDING, "a command that names another job does not wait for the first job");
  }

  // 9. The real path: eve's bash tool on a laned just-bash root. A recorder under the lane counts the
  //    commands in flight on the root. eve's claim (after the yield) and its cancel (on abort) are second
  //    commands on the same root. Neither may start while the job still runs.
  {
    const { JustBashSandbox } = await import("eve/sandbox/just-bash");
    const { bash } = (await import("eve/tools/bash")) as unknown as {
      bash: { execute(input: { command: string; timeout?: number }, ctx: { getSandbox(): Promise<unknown>; abortSignal?: AbortSignal }): Promise<Record<string, unknown>> };
    };
    // eve exports no session factory, so the test takes the one eve's own sandbox setup uses.
    const evePublic = fileURLToPath(import.meta.resolve("eve/sandbox/just-bash"));
    const { createConnectionSession } = (await import(join(dirname(dirname(dirname(evePublic))), "execution/sandbox/session.js"))) as {
      createConnectionSession(c: object): unknown;
    };
    type Spawn = (o: { command: string; signal?: AbortSignal }) => Promise<{ wait(): Promise<unknown> }>;
    const recorded = (connection: { spawn: Spawn }, ignoreAbort: boolean) => {
      const rec = { inFlight: 0, maxInFlight: 0, commands: [] as string[], ended: 0 };
      const proxy = new Proxy(connection, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (prop !== "spawn") return value;
          return async (o: { command: string; signal?: AbortSignal }) => {
            rec.commands.push(o.command);
            rec.inFlight += 1;
            rec.maxInFlight = Math.max(rec.maxInFlight, rec.inFlight);
            const proc = await (value as Spawn).call(target, ignoreAbort ? { ...o, signal: undefined } : o);
            const end = (): void => {
              rec.inFlight -= 1;
              rec.ended += 1;
            };
            void proc.wait().then(end, end);
            return proc;
          };
        },
      });
      return { rec, proxy };
    };
    const raw = providerRuntimeOf(JustBashSandbox.environment({})).implementation as unknown as {
      resume(ctx: unknown, artifact: unknown, state: unknown): Promise<{ spawn: Spawn }>;
    };
    const openRoot = async (ignoreAbort: boolean) => {
      const root = mkdtempSync(join(tmpdir(), "oe-jb-eve-job-"));
      let rec!: ReturnType<typeof recorded>["rec"];
      const impl = inExecLaneImplementation(
        {
          ...raw,
          async resume(ctx: unknown, artifact: unknown, state: unknown) {
            const r = recorded(await raw.resume(ctx, artifact, state), ignoreAbort);
            rec = r.rec;
            return r.proxy;
          },
        } as never,
        createExecLanes(200),
      ) as unknown as { resume(ctx: unknown, artifact: unknown, state: unknown): Promise<object> };
      const ctx = { resolveProjectPath: (p: string) => join(coreRoot, p), storagePath: root };
      const session = createConnectionSession(await impl.resume(ctx, undefined, { rootPath: root, version: 2 }));
      return { rec, getSandbox: async () => session };
    };
    const drained = async (rec: { inFlight: number }): Promise<void> => {
      for (let i = 0; i < 200 && rec.inFlight > 0; i++) await new Promise((r) => setTimeout(r, 25));
    };

    // The claim: the command outlives a one-second yield, and the ceiling (200 ms) ends well before the job.
    {
      const { rec, getSandbox } = await openRoot(false);
      const got = await bash.execute({ command: "sleep 2; echo job", timeout: 1 }, { getSandbox });
      const job = eveJobDirectoryOf(rec.commands[0]);
      ok(job !== undefined, "eve's bash tool launches the command as a job with a directory under /tmp/.eve/jobs/");
      ok(rec.commands.slice(1).some((c) => c.startsWith(`cd '${job}'`) && eveJobDirectoryOf(c) === job), "🔴 eve claims the job with a second command that names the job's directory — if eve changed that shape, re-key the lane");
      eq(rec.maxInFlight, 1, "🔴 eve's claim never runs on the root while its job still runs");
      eq([got.status, got.stdout, got.exitCode], ["completed", "job\n", 0], "the tool still returns the job's whole output");
      // eve's launch command opens with the guard that picks its job launcher. Run that same guard on the
      // root: on just-bash it must take the direct path, so a job never yields as running.
      const guard = rec.commands[0]!.split("\n")[0]!;
      ok(guard.startsWith("if ") && guard.endsWith("; then"), "eve's launch command opens with its launcher guard");
      const session = (await getSandbox()) as { run(o: { command: string }): Promise<{ stdout: string }> };
      const path = await session.run({ command: `${guard} echo launcher; else echo direct; fi` });
      eq(path.stdout, "direct\n", "🔴 eve's own launcher guard takes the direct path on just-bash — if the launcher runs, a job can yield as running, and the no-ceiling job wait would hold eve's claim until the job ends; re-design the key");
      const after = await settledWithin(bash.execute({ command: "true 2>/dev/null; echo after", timeout: 5 }, { getSandbox }), 6_000);
      ok(after !== PENDING && after.stdout === "after\n", "a later command with a redirection on the root returns");
    }

    // The cancel: the tool call is aborted while the job runs on, so eve sends its kill command.
    {
      const { rec, getSandbox } = await openRoot(true);
      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error("stop")), 300);
      await bash.execute({ command: "sleep 1.5; echo job", timeout: 5 }, { getSandbox, abortSignal: ac.signal }).catch(() => undefined);
      await drained(rec);
      const job = eveJobDirectoryOf(rec.commands[0]);
      ok(rec.commands.slice(1).some((c) => c.startsWith("kill -TERM") && eveJobDirectoryOf(c) === job), "🔴 eve cancels the job with a second command that names the job's directory — if eve changed that shape, re-key the lane");
      eq(rec.maxInFlight, 1, "🔴 eve's cancel never runs on the root while its job still runs");
      const after = await settledWithin(bash.execute({ command: "true 2>/dev/null; echo after", timeout: 5 }, { getSandbox }), 6_000);
      ok(after !== PENDING && after.stdout === "after\n", "a later command with a redirection on the root returns");
    }
  }

  ok(JUST_BASH_EXEC_LANE_CEILING_MS === 10_000, "the ceiling is 10 s");
  console.log(`✓ just-bash-exec-lane: ${n} checks`);
}
