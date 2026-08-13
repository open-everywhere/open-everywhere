import { Sandbox } from "@vercel/sandbox";
import { execFile } from "node:child_process";
import { onVercel, resolveSelfHostBackendKind } from "@open-everywhere/core/agent/adapter-api.js";

export interface SandboxListing {
  readonly name: string;
  readonly status: string;
  readonly createdAt: number;
}

export interface SandboxStopper {
  readonly backend: string;
  readonly metered: boolean;
  readonly ownership: string;
  list(sessionId: string): Promise<SandboxListing[]>;
  stop(name: string): Promise<void>;
  retag(name: string, sessionId: string): Promise<boolean>;
}

export function shouldStop(status: string): boolean {
  return status === "running" || status === "pending";
}

export const vercelStopper: SandboxStopper = {
  backend: "vercel",
  metered: true,
  ownership:
    "stop owner = vercel — @vercel/sandbox stops the session VM at turn end, and its runtime seconds are priced into the spend ledger",
  async list(sessionId) {
    const result = await Sandbox.list({ tags: { sessionId } });
    const out: SandboxListing[] = [];
    for await (const s of result) out.push({ name: s.name, status: s.status, createdAt: s.createdAt });
    return out;
  },
  async stop(name) {
    await (await Sandbox.get({ name, resume: false })).stop();
  },
  async retag(name, sessionId) {
    const sandbox = await Sandbox.get({ name, resume: false });
    await sandbox.update({ tags: { ...(sandbox.tags ?? {}), sessionId } });
    return true;
  },
};

export const DOCKER_SESSION_LABEL = "eve.sandbox.tag.sessionId";

export interface DockerRunner {
  (args: readonly string[]): Promise<string>;
}

const defaultDockerRunner: DockerRunner = async (args) =>
  await new Promise<string>((resolve, reject) => {
    const bin = process.env.EVE_DOCKER_PATH?.trim() || "docker";
    execFile(bin, [...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export function dockerStatusToSandboxStatus(state: string): string {
  if (state === "running") return "running";
  if (state === "created" || state === "restarting") return "pending";
  return state;
}

const DOCKER_START_TIME_FLOOR_MS = Date.UTC(2000, 0, 1);

export function createDockerStopper(run: DockerRunner = defaultDockerRunner): SandboxStopper {
  return {
    backend: "docker",
    metered: false,
    ownership:
      "stop owner = docker — eve's session containers are stopped through the docker CLI at turn end. Runtime is NOT metered per second on this backend, so no spend-ledger row is written for it",
    async list(sessionId) {
      const names = (await run(["ps", "-a", "--no-trunc", "--filter", `label=${DOCKER_SESSION_LABEL}=${sessionId}`, "--format", "{{.Names}}"]))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (names.length === 0) return [];
      let inspected: string;
      try {
        inspected = await run(["inspect", "--format", "{{.Name}}\t{{.State.Status}}\t{{.State.StartedAt}}", ...names]);
      } catch {
        const now = Date.now();
        return names.map((name) => ({ name, status: "running", createdAt: now }));
      }
      const out: SandboxListing[] = [];
      for (const line of inspected.split("\n")) {
        const [rawName, state, startedAt] = line.trim().split("\t");
        if (rawName === undefined || state === undefined) continue;
        const name = rawName.replace(/^\//, "");
        if (name.length === 0) continue;
        const parsed = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
        const createdAt = Number.isFinite(parsed) && parsed >= DOCKER_START_TIME_FLOOR_MS ? parsed : Date.now();
        out.push({ name, status: dockerStatusToSandboxStatus(state), createdAt });
      }
      return out;
    },
    async stop(name) {
      await run(["stop", "-t", "0", name]);
    },
    async retag() {
      return false;
    },
  };
}

export const justBashStopper: SandboxStopper = {
  backend: "just-bash",
  metered: false,
  ownership:
    "stop owner = NONE — the just-bash backend runs inside this app process. There is no VM or container to stop and no metered runtime, so the turn-end sweep is inert by design. Set OE_SANDBOX_BACKEND=docker for a backend whose compute is stopped at turn end",
  async list() {
    return [];
  },
  async stop() {
  },
  async retag() {
    return false;
  },
};

export function resolveSandboxStopper(): SandboxStopper {
  if (forcedStopper !== undefined) return forcedStopper;
  if (onVercel()) return vercelStopper;
  return resolveSelfHostBackendKind() === "justbash" ? justBashStopper : createDockerStopper();
}

let forcedStopper: SandboxStopper | undefined;
export function setSandboxStopperForTest(stopper: SandboxStopper | undefined): void {
  forcedStopper = stopper;
}
