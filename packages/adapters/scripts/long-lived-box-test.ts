import assert from "node:assert/strict";
import { BOX_LABEL, overrideSettingsForTest, resetSettingsForTest, type BoxSpec } from "@open-everywhere/core/agent/adapter-api.js";
import {
  DOCKER_BOX_LABEL,
  DOCKER_BOX_PERSIST_LABEL,
  createDockerBoxBackend,
  createVercelBoxBackend,
  dockerRunArgs,
  justBashBoxBackend,
  selectLongLivedBoxBackend,
  VERCEL_BOX_CEILING_MINUTES,
  type VercelBoxSdk,
} from "../agent/sandbox/long-lived-box.js";
import { DOCKER_SESSION_LABEL, createDockerStopper } from "../agent/sandbox/backend-stop.js";
import { gatewayTranscriptionRoute } from "../agent/model/meeting-gateway.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const spec = (over: Partial<BoxSpec> = {}): BoxSpec => ({
  purpose: "meeting",
  ref: "mtg_abc",
  image: "oe-meeting-bot:1",
  command: ["node", "/opt/oe-meeting-bot/bot.mjs"],
  vcpus: 2,
  memoryMb: 4096,
  shmMb: 1024,
  maxMinutes: 120,
  env: { OE_MEETING_ID: "mtg_abc" },
  egress: "open",
  ...over,
});

{
  const created: Parameters<VercelBoxSdk["create"]>[0][] = [];
  const ran: { name: string; cmd: string; args: string[]; timeoutMs: number }[] = [];
  const stopped: string[] = [];
  let failRun = false;
  const sdk: VercelBoxSdk = {
    async create(p) {
      created.push(p);
      return { name: `sbx-${created.length}`, createdAt: 1000 };
    },
    async runDetached(name, cmd, args, timeoutMs) {
      if (failRun) throw new Error("exec failed");
      ran.push({ name, cmd, args, timeoutMs });
    },
    async get() {
      return undefined;
    },
    async listByPurpose(purpose) {
      return [{ name: "sbx-1", status: "running", createdAt: 1000, purpose }];
    },
    async stop(name) {
      stopped.push(name);
    },
  };
  const vercel = createVercelBoxBackend(sdk);
  const opened = await vercel.open(spec());
  const c = created[0]!;
  ok(opened.name === "sbx-1" && opened.maxMinutes === 120 && c.timeoutMs === 120 * 60_000, "Vercel: the session timeout is the box's cap");
  ok(!("sessionId" in c.tags) && c.tags[BOX_LABEL] === "meeting" && c.tags.oeBoxRef === "mtg_abc", "Vercel: the box is tagged oeBox/oeBoxRef and never sessionId, so the turn-end stopper cannot list it");
  ok(c.networkPolicy === "allow-all" && c.vcpus === 2 && c.image === "oe-meeting-bot:1", "Vercel: open egress, vCPUs and the image reach the create call");
  ok(ran[0]!.cmd === "node" && ran[0]!.args[0] === "/opt/oe-meeting-bot/bot.mjs" && ran[0]!.timeoutMs === 120 * 60_000, "Vercel: the bot program runs detached under the same cap");
  await vercel.open(spec({ maxMinutes: 5000 }));
  ok(created[1]!.timeoutMs === VERCEL_BOX_CEILING_MINUTES * 60_000, "Vercel: a cap above the 24 h plan ceiling clamps to it");
  await vercel.open(spec({ egress: { allow: ["example.com"] } }));
  await vercel.open(spec({ egress: { allow: [] } }));
  ok(JSON.stringify(created[2]!.networkPolicy) === JSON.stringify({ allow: ["example.com"] }) && created[3]!.networkPolicy === "deny-all", "Vercel: a host list becomes an allow policy, an empty list deny-all");
  failRun = true;
  await assert.rejects(() => vercel.open(spec()), /exec failed/);
  ok(stopped.includes("sbx-5"), "Vercel: a box whose program never started is stopped, not left to idle out its cap");
  const listed = await vercel.list("meeting");
  ok(listed.length === 1 && listed[0]!.purpose === "meeting", "Vercel: list reads the boxes of one purpose");
}

{
  const persisted: Parameters<NonNullable<VercelBoxSdk["openPersistent"]>>[0][] = [];
  const ran: { name: string; env?: Record<string, string> }[] = [];
  const stopped: string[] = [];
  const removed: string[] = [];
  let created = 0;
  let failRun = false;
  const sdk: VercelBoxSdk = {
    async create() {
      created++;
      return { name: "x", createdAt: 1 };
    },
    async runDetached(name, _cmd, _args, _timeoutMs, env) {
      if (failRun) throw new Error("exec failed");
      ran.push({ name, ...(env !== undefined ? { env } : {}) });
    },
    async get() {
      return undefined;
    },
    async listByPurpose() {
      return [];
    },
    async stop(name) {
      stopped.push(name);
    },
    async openPersistent(p) {
      persisted.push(p);
      return { name: p.name, createdAt: 5000 };
    },
    async domain(name, port) {
      return `https://${name}-${port}.vercel.run`;
    },
    async remove(name) {
      removed.push(name);
    },
  };
  const vercel = createVercelBoxBackend(sdk);
  ok(vercel.enforcesHostAllowList === true, "Vercel: the backend says its firewall holds a host list");
  const browserSpec = spec({ purpose: "browser", ref: "oe-pb-abc", persist: { key: "oe-pb-abc", keepDays: 30, mount: "/profile" }, port: 8080, egress: { allow: ["mail.example.com"] }, env: { OE_PB_KEY: "secret-key" } });
  const opened = await vercel.open(browserSpec);
  const p = persisted[0]!;
  ok(created === 0 && p.name === "oe-pb-abc" && p.snapshotExpirationMs === 30 * 24 * 60 * 60_000 && JSON.stringify(p.ports) === "[8080]", "Vercel: a persistent spec opens ONE named sandbox per key, with the snapshot expiry and the port");
  ok(JSON.stringify(p.networkPolicy) === JSON.stringify({ allow: ["mail.example.com"] }) && p.tags[BOX_LABEL] === "browser", "Vercel: the host list reaches the firewall, and the box carries the box label");
  ok(!("env" in p) && ran[0]!.env?.OE_PB_KEY === "secret-key", "🔴 Vercel: the per-open secret goes to the command only, never into the sandbox's stored config");
  ok(opened.url === "https://oe-pb-abc-8080.vercel.run" && opened.name === "oe-pb-abc" && opened.createdAt === 5000, "Vercel: open returns the port's public URL and this session's start");
  failRun = true;
  await assert.rejects(() => vercel.open(browserSpec), /exec failed/);
  ok(stopped.includes("oe-pb-abc"), "Vercel: a persistent box whose program never started is stopped");
  await vercel.forget!("oe-pb-abc");
  ok(removed.includes("oe-pb-abc"), "Vercel: forget deletes the named sandbox and its snapshots");
}

{
  const browserSpec = spec({ purpose: "browser", ref: "oe-pb-abc", persist: { key: "oe-pb-abc", keepDays: 30, mount: "/profile" }, port: 8080, env: { OE_PB_KEY: "secret-key" } });
  const args = dockerRunArgs(browserSpec, "oe-box-browser-oe-pb-abc-n1", 60).join(" ");
  ok(args.includes("--volume oe-pb-abc:/profile") && args.includes(`--label ${DOCKER_BOX_PERSIST_LABEL}=oe-pb-abc`), "docker: a persistent box mounts its named volume and carries the volume label");
  ok(args.includes("--publish 127.0.0.1::8080") && !args.includes("--network"), "🔴 docker: off a named network the port is published on loopback only");
  const onNet = dockerRunArgs({ ...browserSpec, network: "oe-net" }, "n", 60).join(" ");
  ok(onNet.includes("--network oe-net") && !onNet.includes("--publish"), "docker: on a named network the box joins it and publishes nothing");
  assert.throws(() => dockerRunArgs({ ...browserSpec, egress: { allow: [] } }, "n", 60), /cannot serve a port/);
  n++;
  ok(!args.includes("secret-key"), "docker: the per-open key never sits on the argv");

  const calls: string[][] = [];
  const runner = async (a: readonly string[]): Promise<string> => {
    calls.push([...a]);
    if (a[0] === "ps" && a.includes("-q")) return "oldbox\n";
    if (a[0] === "inspect") return `/oe-box-browser-oe-pb-abc-n1\trunning\t2026-10-11T10:00:00Z\tbrowser\toe-pb-abc\n`;
    if (a[0] === "port") return "127.0.0.1:49153\n";
    return "";
  };
  const docker = createDockerBoxBackend(runner, () => "n1");
  ok(docker.enforcesHostAllowList === false, "docker: the backend says it cannot hold a host list");
  const opened = await docker.open(browserSpec);
  const stopIdx = calls.findIndex((c) => c[0] === "stop" && c.includes("oldbox"));
  const runIdx = calls.findIndex((c) => c[0] === "run");
  ok(stopIdx >= 0 && stopIdx < runIdx && calls.some((c) => c[0] === "ps" && c.includes(`label=${DOCKER_BOX_PERSIST_LABEL}=oe-pb-abc`)), "🔴 docker: a box still on the same volume is stopped BEFORE the new one runs");
  ok(opened.url === "http://127.0.0.1:49153", "docker: open returns the loopback port docker picked");
  await docker.forget!("oe-pb-abc");
  ok(calls.some((c) => c.join(" ") === "volume rm -f oe-pb-abc"), "docker: forget removes the named volume");
}

{
  const args = dockerRunArgs(spec(), "oe-box-meeting-mtg_abc-1", 120);
  const joined = args.join(" ");
  ok(args[0] === "run" && args.includes("-d") && args.includes("--rm"), "docker: the box runs detached and removes itself when its program exits");
  ok(joined.includes("--cpus 2") && joined.includes("--memory 4096m") && joined.includes("--shm-size 1024m"), "docker: --cpus, --memory and --shm-size size the box (eve's own docker binding sets none of them)");
  ok(joined.includes("--cap-drop ALL") && joined.includes("--security-opt no-new-privileges") && /--pids-limit \d+/.test(joined), "docker: the box drops every capability, gains no privileges and has a pid ceiling");
  ok(dockerRunArgs(spec({ user: "pwuser" }), "x", 1).join(" ").includes("--user pwuser") && !joined.includes("--user"), "docker: the box runs as the spec's non-root user when it names one");
  ok(joined.includes(`--label ${DOCKER_BOX_LABEL}=meeting`) && !joined.includes("sessionId"), "docker: the box carries the oe.box label and never eve's sessionId label");
  ok(String(DOCKER_BOX_LABEL) !== String(DOCKER_SESSION_LABEL), "docker: the box label and the turn-end stopper's label are different keys");
  ok(joined.includes("--entrypoint timeout oe-meeting-bot:1 7200s node /opt/oe-meeting-bot/bot.mjs"), "docker: coreutils `timeout` caps the program at the box's cap");
  ok(joined.includes("--env OE_MEETING_ID") && !args.some((a) => a.startsWith("OE_MEETING_ID=")) && !args.includes("--network"), "docker: the argv names each env var WITHOUT its value, and open egress joins the default network");
  ok(dockerRunArgs(spec({ egress: { allow: [] } }), "x", 1).join(" ").includes("--network none"), "docker: an empty allow-list means no network at all");
  assert.throws(() => dockerRunArgs(spec({ egress: { allow: ["example.com"] } }), "x", 1), /cannot enforce a host allow-list/);
  n++;

  const calls: string[][] = [];
  const envs: (Readonly<Record<string, string>> | undefined)[] = [];
  const runner = async (a: readonly string[], e?: Readonly<Record<string, string>>): Promise<string> => {
    calls.push([...a]);
    envs.push(e);
    if (a[0] === "inspect") return `/oe-box-meeting-mtg_abc-n1\trunning\t2026-10-11T10:00:00Z\tmeeting\tmtg_abc\n`;
    if (a[0] === "ps") return "oe-box-meeting-mtg_abc-n1\n";
    return "";
  };
  const docker = createDockerBoxBackend(runner, () => "n1");
  const opened = await docker.open(spec({ maxMinutes: 99999 }));
  ok(envs[calls.findIndex((c) => c[0] === "run")]?.OE_MEETING_ID === "mtg_abc", "docker: the env VALUES travel in the CLI's own environment");
  ok(opened.name === "oe-box-meeting-mtg_abc-n1" && opened.maxMinutes === 24 * 60 && opened.createdAt === Date.parse("2026-10-11T10:00:00Z"), "docker: open names the box, clamps the cap to 24 h and reads the start time back");
  const listed = await docker.list("meeting");
  ok(listed.length === 1 && listed[0]!.ref === "mtg_abc" && listed[0]!.status === "running", "docker: list reads purpose and ref back from the labels");
  ok(calls.some((c) => c[0] === "ps" && c.includes(`label=${DOCKER_BOX_LABEL}=meeting`)), "docker: list filters on the box label");
  await docker.stop("oe-box-meeting-mtg_abc-n1");
  ok(calls.some((c) => c[0] === "stop" && c.includes("oe-box-meeting-mtg_abc-n1")), "docker: stop stops the named box");
  const failing = createDockerBoxBackend(async (a) => {
    if (a[0] === "stop") throw new Error("No such container");
    return "";
  });
  await failing.stop("gone");
  n++;

  const stopperCalls: string[][] = [];
  const stopper = createDockerStopper(async (a) => {
    stopperCalls.push([...a]);
    return "";
  });
  await stopper.list("sess-1");
  ok(stopperCalls[0]!.includes(`label=${DOCKER_SESSION_LABEL}=sess-1`) && !stopperCalls[0]!.join(" ").includes("oe.box"), "the turn-end docker stopper filters on eve's sessionId label, never the box label");
}

{
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "oe-fake-docker-"));
  const fake = join(dir, "docker");
  writeFileSync(fake, `#!/bin/sh\necho "Unable to find image 'oe-meeting-bot:1' locally" >&2\necho "$@ $OE_MEETING_SECRET" >&2\nexit 125\n`);
  chmodSync(fake, 0o755);
  const prev = process.env.EVE_DOCKER_PATH;
  process.env.EVE_DOCKER_PATH = fake;
  const SECRET = "whsec_c2VjcmV0LXNlbnRpbmVsLXZhbHVl";
  let message = "";
  try {
    await createDockerBoxBackend().open(spec({ env: { OE_MEETING_SECRET: SECRET, OE_MEETING_URL: "https://meet.google.com/abc-defg-hij?pwd=passcode" } }));
  } catch (err) {
    message = String(err);
  }
  if (prev === undefined) delete process.env.EVE_DOCKER_PATH;
  else process.env.EVE_DOCKER_PATH = prev;
  ok(message.includes("docker run failed: Unable to find image"), "docker: a failed run names the verb and docker's first stderr line");
  ok(!message.includes(SECRET) && !message.includes("passcode") && !message.includes("--env"), "docker: the error carries no argv, no env value and no meeting passcode (it reaches a card and an audit row)");
}

{
  ok(justBashBoxBackend.unavailable !== undefined && justBashBoxBackend.unavailable.includes("cannot run a long-lived box"), "just-bash declares itself unavailable with a reason");
  await assert.rejects(() => justBashBoxBackend.open(spec()), /cannot run a long-lived box/);
  n++;
  overrideSettingsForTest({ sandbox: { selfHostBackend: "justbash" } });
  ok(selectLongLivedBoxBackend().backend === "justbash", "a just-bash deployment selects the refusing backend");
  overrideSettingsForTest({ sandbox: { selfHostBackend: "docker" } });
  ok(selectLongLivedBoxBackend().backend === "docker", "a docker deployment selects the docker box backend");
  overrideSettingsForTest({ sandbox: { useVercelSandbox: true } });
  ok(selectLongLivedBoxBackend().backend === "vercel", "sandbox.useVercelSandbox selects the Vercel box backend, the same rule as the turn-end stopper");
  resetSettingsForTest();
}

{
  const sent: { model: string; bytes: number }[] = [];
  const route = gatewayTranscriptionRoute(async (model, audio) => {
    sent.push({ model, bytes: audio.byteLength });
    return "hello world";
  });
  ok(route.id === "gateway" && route.disclosure.includes("AI Gateway"), "the gateway route discloses where the audio goes");
  const text = await route.transcribe({ kind: "audio", mediaType: "audio/webm", data: new Uint8Array([1, 2, 3]) }, { model: "openai/gpt-4o-transcribe", scope: "slack/T/C" });
  ok(text === "hello world" && sent[0]!.model === "openai/gpt-4o-transcribe" && sent[0]!.bytes === 3, "the gateway route sends the audio bytes to the policy's model");
  await assert.rejects(() => route.transcribe({ kind: "text", text: "x" }, { model: "m", scope: "s" }), /transcribes audio/);
  await assert.rejects(() => route.transcribe({ kind: "audio", mediaType: "audio/webm", data: new Uint8Array() }, { scope: "s" }), /needs transcription.model/);
  n += 2;
}

console.log(`✓ long-lived-box-test: ${n} assertions`);
