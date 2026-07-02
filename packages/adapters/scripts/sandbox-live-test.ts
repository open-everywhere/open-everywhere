import { Sandbox } from "@vercel/sandbox";
import { stopSessionSandboxes } from "../agent/sandbox/vercel-lifecycle.js";

if (!process.env.VERCEL_OIDC_TOKEN && !process.env.VERCEL_TOKEN) {
  console.error("sandbox-live: SKIPPED — no VERCEL_OIDC_TOKEN/VERCEL_TOKEN in env (run `vercel env pull` and source .env.local).");
  process.exit(2);
}

const runId = Math.random().toString(36).slice(2, 8);
const t0 = Date.now();
const el = () => `t+${((Date.now() - t0) / 1000).toFixed(0)}s`;
let passed = 0;
const failures: string[] = [];
const ok = (cond: boolean, label: string) => {
  if (cond) {
    passed++;
    console.log(`[${el()}] ✓ ${label}`);
  } else {
    failures.push(label);
    console.error(`[${el()}] ✗ ${label}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const names: string[] = [];
const mk = (tag: string) => {
  const name = `oe-live-${tag}-${runId}`;
  names.push(name);
  return name;
};

async function scenarioFuse(): Promise<void> {
  const name = mk("fuse");
  const sb = await Sandbox.create({ name, timeout: 90_000, resources: { vcpus: 2 } });
  ok(sb.status === "running", "A: created sandbox is running");
  let died = false;
  let completed = false;
  const long = sb
    .runCommand("bash", ["-c", "for i in $(seq 1 180); do echo $i >> /vercel/sandbox/ticks.txt; sleep 1; done"])
    .then(() => {
      completed = true;
    })
    .catch(() => {
      died = true;
    });
  await sleep(45_000);
  await sleep(75_000);
  ok(died && !completed, "A: command in flight at fuse expiry DIED (fixed window; activity did not extend)");
  const meta = await Sandbox.get({ name });
  ok(meta.status === "stopped" || meta.status === "snapshotting", `A: session auto-stopped at the fuse (status=${meta.status})`);
  const r = await (await Sandbox.get({ name })).runCommand("bash", ["-c", "wc -l < /vercel/sandbox/ticks.txt"]);
  const ticks = Number((await r.stdout()).trim());
  ok(ticks >= 60 && ticks <= 110, `A: fuse-triggered auto-stop SNAPSHOTTED — partial work survived resume (${ticks} ticks ≈ fuse length)`);
  const meta2 = await Sandbox.get({ name });
  ok(meta2.status === "running", "A: auto-resume booted a NEW session (running again)");
  await long;
}

async function scenarioStopResume(): Promise<void> {
  const name = mk("stop");
  const sb = await Sandbox.create({ name, timeout: 240_000, resources: { vcpus: 2 } });
  await sb.runCommand("bash", ["-c", "echo from-session-1 > /vercel/sandbox/marker.txt"]);
  await sb.stop();
  const meta = await Sandbox.get({ name });
  ok(meta.status === "stopped", "B: manual .stop() → stopped");
  const t = Date.now();
  const r = await (await Sandbox.get({ name })).runCommand("cat", ["/vercel/sandbox/marker.txt"]);
  const resumeMs = Date.now() - t;
  ok((await r.stdout()).trim() === "from-session-1", "B: auto-resume restored the filesystem (marker intact)");
  ok(resumeMs < 15_000, `B: resume→result under 15s (took ${resumeMs}ms; typically 0.5–3s)`);
  const sb2 = await Sandbox.get({ name });
  const stopP = sb2.stop();
  await sleep(500);
  const r2 = await (await Sandbox.get({ name })).runCommand("echo", ["mid-stop"]);
  ok((await r2.stdout()).trim() === "mid-stop", "B: command issued MID-stop rides it out (no failure)");
  await stopP.catch(() => undefined);
}

async function scenarioExtend(): Promise<void> {
  const name = mk("ext");
  const sb = await Sandbox.create({ name, timeout: 90_000, resources: { vcpus: 2 } });
  ok(sb.timeout === 90_000, "E: .timeout reports the CONFIGURED value at boot");
  let completed = false;
  const long = sb
    .runCommand("bash", ["-c", "sleep 130 && echo SURVIVED > /vercel/sandbox/survived.txt"])
    .then(() => {
      completed = true;
    })
    .catch(() => undefined);
  await sleep(30_000);
  await sb.extendTimeout(120_000);
  const meta = await Sandbox.get({ name });
  ok(meta.timeout === 90_000, "E: .timeout STILL reports configured value after extend (no visible countdown)");
  await sleep(110_000);
  const alive = await Sandbox.get({ name });
  ok(alive.status === "running", "C: session still running past the original fuse after extendTimeout");
  await long;
  ok(completed, "C: in-flight command OUTLIVED the original fuse and completed (extend works mid-command)");
}

async function scenarioHook(): Promise<void> {
  const sessionId = `oe-live-hook-${runId}`;
  const name = mk("hook");
  await Sandbox.create({ name, timeout: 240_000, resources: { vcpus: 2 }, tags: { sessionId } });
  const stopped = await stopSessionSandboxes(sessionId);
  ok(stopped.length === 1 && stopped[0] === name, "D: hook's real SDK path found the tagged sandbox and stopped it");
  const meta = await Sandbox.get({ name });
  ok(meta.status === "stopped" || meta.status === "snapshotting" || meta.status === "stopping", `D: sandbox is stopping/stopped after the hook (status=${meta.status})`);
  const again = await stopSessionSandboxes(sessionId);
  ok(again.length === 0, "D: idempotent — second sweep finds nothing left to stop");
}

try {
  console.log(`[${el()}] running 4 scenarios concurrently (run ${runId})…`);
  const results = await Promise.allSettled([scenarioFuse(), scenarioStopResume(), scenarioExtend(), scenarioHook()]);
  for (const r of results) {
    if (r.status === "rejected") failures.push(`scenario crashed: ${String(r.reason).slice(0, 200)}`);
  }
} finally {
  for (const name of names) {
    try {
      await (await Sandbox.get({ name })).delete();
    } catch {
    }
  }
  console.log(`[${el()}] cleanup: deleted ${names.length} sandboxes`);
}

if (failures.length > 0) {
  console.error(`\n✗ sandbox-live: ${failures.length} FAILED, ${passed} passed\n${failures.map((f) => `  ✗ ${f}`).join("\n")}\n`);
  process.exit(1);
}
console.log(`\n✓ sandbox-live: ${passed} assertions passed against the real platform (fuse, stop/resume, extend, hook)\n`);
