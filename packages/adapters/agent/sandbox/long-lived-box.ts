import { Sandbox } from "@vercel/sandbox";
import {
  BOX_LABEL,
  BOX_PURPOSES,
  BOX_REF_LABEL,
  boxDockerNetwork,
  boxEgressBehindProxy,
  boxLabels,
  clampBoxMinutes,
  dropBoxEgressPolicy,
  pushBoxEgressPolicy,
  registerLongLivedBoxBackend,
  resolveEgressRoute,
  resolveSandboxBackend,
  type BoxListing,
  type BoxPurpose,
  type BoxSpec,
  type LongLivedBoxBackend,
  type OpenedBox,
} from "@open-everywhere/core/agent/adapter-api.js";
import { dockerStatusToSandboxStatus } from "./backend-stop.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { SandboxNetworkPolicy } from "eve/sandbox";

export const VERCEL_BOX_CEILING_MINUTES = 24 * 60;
const DOCKER_BOX_CEILING_MINUTES = 24 * 60;

function isPurpose(v: string | undefined): v is BoxPurpose {
  return (BOX_PURPOSES as readonly (string | undefined)[]).includes(v);
}

export interface VercelBoxSdk {
  create(params: {
    image: string;
    vcpus: number;
    timeoutMs: number;
    tags: Record<string, string>;
    env: Record<string, string>;
    networkPolicy: "allow-all" | "deny-all" | { allow: string[] };
  }): Promise<{ name: string; createdAt: number }>;
  runDetached(name: string, cmd: string, args: string[], timeoutMs: number, env?: Record<string, string>): Promise<void>;
  get(name: string): Promise<BoxListing | undefined>;
  listByPurpose(purpose: BoxPurpose): Promise<BoxListing[]>;
  stop(name: string): Promise<void>;
  openPersistent?(params: {
    name: string;
    image: string;
    vcpus: number;
    timeoutMs: number;
    tags: Record<string, string>;
    networkPolicy: "allow-all" | "deny-all" | { allow: string[] };
    snapshotExpirationMs: number;
    ports: number[];
  }): Promise<{ name: string; createdAt: number }>;
  domain?(name: string, port: number): Promise<string>;
  remove?(name: string): Promise<void>;
}

const defaultVercelBoxSdk: VercelBoxSdk = {
  async create(p) {
    const sandbox = await Sandbox.create({
      image: p.image,
      resources: { vcpus: p.vcpus },
      timeout: p.timeoutMs,
      tags: p.tags,
      env: p.env,
      networkPolicy: p.networkPolicy,
      persistent: false,
    });
    return { name: sandbox.name, createdAt: sandbox.createdAt.getTime() };
  },
  async runDetached(name, cmd, args, timeoutMs, env) {
    const sandbox = await Sandbox.get({ name, resume: false });
    await sandbox.runCommand({ cmd, args, detached: true, timeoutMs, ...(env !== undefined ? { env } : {}) });
  },
  async get(name) {
    try {
      const s = await Sandbox.get({ name, resume: false });
      const purpose = s.tags?.[BOX_LABEL];
      return {
        name: s.name,
        status: s.status,
        createdAt: s.createdAt.getTime(),
        ...(isPurpose(purpose) ? { purpose } : {}),
        ...(s.tags?.[BOX_REF_LABEL] !== undefined ? { ref: s.tags[BOX_REF_LABEL] } : {}),
      };
    } catch {
      return undefined;
    }
  },
  async listByPurpose(purpose) {
    const result = await Sandbox.list({ tags: { oeBox: purpose } });
    const out: BoxListing[] = [];
    for await (const s of result) out.push({ name: s.name, status: s.status, createdAt: s.createdAt, purpose });
    return out;
  },
  async stop(name) {
    try {
      await (await Sandbox.get({ name, resume: false })).stop();
    } catch {
    }
  },
  async openPersistent(p) {
    let existing: Sandbox | undefined;
    try {
      existing = await Sandbox.get({ name: p.name, resume: false });
    } catch {
      existing = undefined;
    }
    if (existing === undefined) {
      await Sandbox.create({
        name: p.name,
        image: p.image,
        resources: { vcpus: p.vcpus },
        timeout: p.timeoutMs,
        tags: p.tags,
        networkPolicy: p.networkPolicy,
        ports: p.ports,
        persistent: true,
        snapshotExpiration: p.snapshotExpirationMs,
      });
      return { name: p.name, createdAt: Date.now() };
    }
    if (existing.status === "running" || existing.status === "pending") await existing.stop();
    await existing.update({ timeout: p.timeoutMs, networkPolicy: p.networkPolicy, ports: p.ports, tags: p.tags, snapshotExpiration: p.snapshotExpirationMs });
    return { name: p.name, createdAt: Date.now() };
  },
  async domain(name, port) {
    return (await Sandbox.get({ name, resume: false })).domain(port);
  },
  async remove(name) {
    try {
      await (await Sandbox.get({ name, resume: false })).delete({ deleteOrphanSnapshots: true });
    } catch {
    }
  },
};

function vercelNetworkPolicy(egress: BoxSpec["egress"]): "allow-all" | "deny-all" | { allow: string[] } {
  return egress === "open" ? "allow-all" : egress.allow.length === 0 ? "deny-all" : { allow: [...egress.allow] };
}

export function createVercelBoxBackend(sdk: VercelBoxSdk = defaultVercelBoxSdk): LongLivedBoxBackend {
  return {
    backend: "vercel",
    metered: true,
    maxMinutesCeiling: VERCEL_BOX_CEILING_MINUTES,
    enforcesHostAllowList: true,
    async open(spec: BoxSpec): Promise<OpenedBox> {
      const [cmd, ...args] = spec.command;
      if (cmd === undefined) throw new Error("a box needs a command to run");
      const maxMinutes = clampBoxMinutes(spec.maxMinutes, VERCEL_BOX_CEILING_MINUTES);
      const timeoutMs = maxMinutes * 60_000;
      if (spec.persist !== undefined) {
        if (sdk.openPersistent === undefined || sdk.domain === undefined) throw new Error("this Vercel box SDK cannot keep a box's files between opens");
        const opened = await sdk.openPersistent({
          name: spec.persist.key,
          image: spec.image,
          vcpus: Math.max(1, Math.floor(spec.vcpus)),
          timeoutMs,
          tags: boxLabels(spec),
          networkPolicy: vercelNetworkPolicy(spec.egress),
          snapshotExpirationMs: Math.max(1, Math.floor(spec.persist.keepDays)) * 24 * 60 * 60_000,
          ports: spec.port !== undefined ? [spec.port] : [],
        });
        try {
          await sdk.runDetached(opened.name, cmd, args, timeoutMs, { ...spec.env });
        } catch (err) {
          await sdk.stop(opened.name);
          throw err;
        }
        const url = spec.port !== undefined ? await sdk.domain(opened.name, spec.port) : undefined;
        return { name: opened.name, backend: "vercel", createdAt: opened.createdAt, maxMinutes, ...(url !== undefined ? { url } : {}) };
      }
      const created = await sdk.create({
        image: spec.image,
        vcpus: Math.max(1, Math.floor(spec.vcpus)),
        timeoutMs,
        tags: boxLabels(spec),
        env: { ...spec.env },
        networkPolicy: vercelNetworkPolicy(spec.egress),
      });
      try {
        await sdk.runDetached(created.name, cmd, args, timeoutMs);
      } catch (err) {
        await sdk.stop(created.name);
        throw err;
      }
      return { name: created.name, backend: "vercel", createdAt: created.createdAt, maxMinutes };
    },
    status: async (name) => await sdk.get(name),
    list: async (purpose) => await sdk.listByPurpose(purpose),
    stop: async (name) => await sdk.stop(name),
    async forget(key) {
      if (sdk.remove === undefined) throw new Error("this Vercel box SDK cannot delete a persistent box");
      await sdk.remove(key);
    },
  };
}

const DOCKER_BOX_PIDS_LIMIT = 2048;

export const DOCKER_BOX_LABEL = `oe.box.${BOX_LABEL}`;
const DOCKER_BOX_REF_LABEL = `oe.box.${BOX_REF_LABEL}`;
export const DOCKER_BOX_PERSIST_LABEL = "oe.box.oePersist";

function dockerVolumeName(key: string): string {
  const clean = key.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 60);
  return clean.length > 0 ? clean : "oe-box-data";
}

export type BoxDockerRunner = (args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<string>;

const defaultDockerRunner: BoxDockerRunner = async (args, env) =>
  await new Promise<string>((resolve, reject) => {
    const bin = process.env.EVE_DOCKER_PATH?.trim() || "docker";
    execFile(bin, [...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...(env !== undefined ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args[0] ?? ""} failed: ${String(stderr).split("\n")[0]?.trim() || "no error output"}`));
      else resolve(stdout);
    });
  });

function dockerBoxName(spec: Pick<BoxSpec, "purpose" | "ref">, nonce: string): string {
  const ref = spec.ref.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  return `oe-box-${spec.purpose}-${ref}-${nonce}`;
}

export interface DockerBoxProxyPlacement {
  readonly network: string;
  readonly forwardProxy: string;
}

const PROXY_BOX_PURPOSES: readonly BoxPurpose[] = ["browser", "browser-qa"];

export const BOX_DNS_SUFFIX = "oe-box";

export const BOX_EGRESS_PROXY_ENV = "OE_BOX_EGRESS_PROXY";
export const BOX_EGRESS_CA_ENV = "OE_BOX_EGRESS_CA";

export function boxProxyPolicy(egress: Exclude<BoxSpec["egress"], "open">): SandboxNetworkPolicy {
  return egress.allow.length === 0 ? "deny-all" : ({ allow: [...egress.allow] } as unknown as SandboxNetworkPolicy);
}

export function dockerRunArgs(spec: BoxSpec, name: string, maxMinutes: number, proxied?: DockerBoxProxyPlacement): string[] {
  if (proxied !== undefined) {
    if (!PROXY_BOX_PURPOSES.includes(spec.purpose)) {
      throw new Error(`a ${spec.purpose} box cannot run behind the egress proxy (its traffic is not HTTP), and this deployment runs boxes only there — refusing to open it`);
    }
    if (spec.egress === "open") {
      throw new Error("a box behind the egress proxy cannot run with open egress (the proxy refuses no private address) — declare the hosts instead of a catch-all");
    }
  } else if (spec.egress !== "open" && spec.egress.allow.length > 0) {
    throw new Error("the docker backend cannot enforce a host allow-list on a box — refusing to open it with open network");
  }
  const labels = boxLabels(spec);
  const args = [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    `${DOCKER_BOX_LABEL}=${labels[BOX_LABEL]}`,
    "--label",
    `${DOCKER_BOX_REF_LABEL}=${labels[BOX_REF_LABEL]}`,
    "--cpus",
    String(Math.max(0.5, spec.vcpus)),
    "--memory",
    `${Math.max(256, Math.floor(spec.memoryMb))}m`,
    "--shm-size",
    `${Math.max(64, Math.floor(spec.shmMb ?? 64))}m`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(DOCKER_BOX_PIDS_LIMIT),
    ...(spec.user !== undefined ? ["--user", spec.user] : []),
  ];
  if (spec.persist !== undefined) {
    args.push("--label", `${DOCKER_BOX_PERSIST_LABEL}=${dockerVolumeName(spec.persist.key)}`, "--volume", `${dockerVolumeName(spec.persist.key)}:${spec.persist.mount}`);
  }
  if (proxied !== undefined) {
    args.push("--network", proxied.network, "--network-alias", `${name}.${BOX_DNS_SUFFIX}`);
  } else if (spec.egress !== "open") {
    if (spec.port !== undefined) throw new Error("a docker box with no network cannot serve a port — refusing to open it");
    args.push("--network", "none");
  } else if (spec.network !== undefined) {
    args.push("--network", spec.network);
  }
  if (spec.port !== undefined && spec.network === undefined && proxied === undefined) args.push("--publish", `127.0.0.1::${spec.port}`);
  for (const k of Object.keys(spec.env)) args.push("--env", k);
  if (proxied !== undefined) {
    for (const k of [BOX_EGRESS_PROXY_ENV, BOX_EGRESS_CA_ENV, "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) if (!(k in spec.env)) args.push("--env", k);
  }
  args.push("--entrypoint", "timeout", spec.image, `${maxMinutes * 60}s`, ...spec.command);
  return args;
}

export interface DockerBoxEgressProxy {
  readonly placement: () => DockerBoxProxyPlacement;
  readonly push: (sourceIp: string, policy: SandboxNetworkPolicy) => Promise<void>;
  readonly drop: (sourceIp: string) => Promise<void>;
  readonly caPem?: () => string | undefined;
}

export function liveDockerBoxEgressProxy(): DockerBoxEgressProxy {
  return {
    placement: () => {
      const network = boxDockerNetwork();
      if (network === undefined) throw new Error("sandbox.boxDockerNetwork is empty, so there is no internal network for the box");
      const route = resolveEgressRoute(new URL("https://example.com/"), process.env, "browser box");
      if (route.via !== "proxy") throw new Error("the app has no HTTPS_PROXY, so a box behind the egress proxy would have no way out — refusing to open it");
      return { network, forwardProxy: route.proxyUrl };
    },
    push: (ip, policy) => pushBoxEgressPolicy(ip, policy),
    drop: (ip) => dropBoxEgressPolicy(ip),
    caPem: () => {
      const path = process.env.NODE_EXTRA_CA_CERTS?.trim();
      if (!path) return undefined;
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

export function createDockerBoxBackend(
  run: BoxDockerRunner = defaultDockerRunner,
  nonce: () => string = () => Date.now().toString(36),
  egressProxy?: DockerBoxEgressProxy,
): LongLivedBoxBackend {
  const boxIps = new Map<string, string>();
  async function stopBox(name: string): Promise<void> {
    let ip = boxIps.get(name);
    if (ip === undefined && egressProxy !== undefined) {
      let network: string | undefined;
      try {
        network = egressProxy.placement().network;
      } catch {
        network = undefined;
      }
      if (network !== undefined) ip = await boxIp(name, network);
    }
    try {
      await run(["stop", "-t", "10", name]);
    } catch {
    }
    if (ip !== undefined && egressProxy !== undefined) {
      boxIps.delete(name);
      try {
        await egressProxy.drop(ip);
      } catch (err) {
        console.error(`[open-everywhere:box] the egress-proxy policy for a stopped box was not dropped (${String(err)})`);
      }
    }
  }
  async function boxIp(name: string, network: string): Promise<string | undefined> {
    try {
      const out = (await run(["inspect", "--format", `{{with index .NetworkSettings.Networks "${network}"}}{{.IPAddress}}{{end}}`, name])).trim();
      return /^[0-9a-f.:]+$/i.test(out) ? out : undefined;
    } catch {
      return undefined;
    }
  }
  async function inspect(names: readonly string[]): Promise<BoxListing[]> {
    if (names.length === 0) return [];
    let out: string;
    try {
      out = await run([
        "inspect",
        "--format",
        `{{.Name}}\t{{.State.Status}}\t{{.State.StartedAt}}\t{{index .Config.Labels "${DOCKER_BOX_LABEL}"}}\t{{index .Config.Labels "${DOCKER_BOX_REF_LABEL}"}}`,
        ...names,
      ]);
    } catch {
      return [];
    }
    const listings: BoxListing[] = [];
    for (const line of out.split("\n")) {
      const [rawName, state, startedAt, purpose, ref] = line.trim().split("\t");
      if (rawName === undefined || state === undefined) continue;
      const parsed = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
      listings.push({
        name: rawName.replace(/^\//, ""),
        status: dockerStatusToSandboxStatus(state),
        createdAt: Number.isFinite(parsed) ? parsed : Date.now(),
        ...(isPurpose(purpose) ? { purpose } : {}),
        ...(ref !== undefined && ref.length > 0 ? { ref } : {}),
      });
    }
    return listings;
  }
  async function stopOnVolume(volume: string): Promise<void> {
    const ids = (await run(["ps", "-q", "--filter", `label=${DOCKER_BOX_PERSIST_LABEL}=${volume}`]))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const id of ids) {
      try {
        await run(["stop", "-t", "10", id]);
      } catch {
      }
    }
  }
  async function boxUrl(spec: BoxSpec, name: string): Promise<string | undefined> {
    if (spec.port === undefined) return undefined;
    if (spec.network !== undefined) return `http://${name}:${spec.port}`;
    const mapped = (await run(["port", name, `${spec.port}/tcp`])).split("\n").map((l) => l.trim()).find((l) => /^127\.0\.0\.1:\d+$/.test(l));
    return mapped === undefined ? undefined : `http://${mapped}`;
  }
  return {
    backend: "docker",
    metered: false,
    maxMinutesCeiling: DOCKER_BOX_CEILING_MINUTES,
    enforcesHostAllowList: egressProxy !== undefined,
    async open(spec) {
      if (spec.command.length === 0) throw new Error("a box needs a command to run");
      const maxMinutes = clampBoxMinutes(spec.maxMinutes, DOCKER_BOX_CEILING_MINUTES);
      const name = dockerBoxName(spec, nonce());
      const placement = egressProxy?.placement();
      const args = dockerRunArgs(spec, name, maxMinutes, placement);
      let env: Readonly<Record<string, string>> = spec.env;
      const control = placement !== undefined && spec.network !== undefined && spec.network !== placement.network ? spec.network : undefined;
      if (placement !== undefined && spec.port !== undefined && spec.network === undefined) {
        throw new Error("a box behind the egress proxy that serves a port needs its own network for the app to reach it (box.dockerNetwork, `oe-net-boxctl` in docker-compose.browser.yml) — refusing to open it");
      }
      if (placement !== undefined) {
        for (const [net, what] of [[placement.network, "sandbox.boxDockerNetwork"], ...(control !== undefined ? [[control, "the box's own network"]] : [])] as const) {
          const internal = (await run(["network", "inspect", "--format", "{{.Internal}}", net])).trim();
          if (internal !== "true") {
            throw new Error(`docker network "${net}" (${what}) is not internal, so a box on it could skip the egress proxy — refusing to open it`);
          }
        }
        const ca = egressProxy?.caPem?.();
        const p = placement.forwardProxy;
        env = { HTTP_PROXY: p, HTTPS_PROXY: p, http_proxy: p, https_proxy: p, ...spec.env, [BOX_EGRESS_PROXY_ENV]: p, ...(ca !== undefined ? { [BOX_EGRESS_CA_ENV]: ca } : {}) };
      }
      if (spec.persist !== undefined) await stopOnVolume(dockerVolumeName(spec.persist.key));
      await run(args, env);
      if (placement !== undefined && egressProxy !== undefined) {
        const ip = await boxIp(name, placement.network);
        try {
          if (ip === undefined) throw new Error(`the box has no IP on "${placement.network}", so the egress proxy cannot hold it`);
          await egressProxy.push(ip, boxProxyPolicy(spec.egress as Exclude<BoxSpec["egress"], "open">));
          if (control !== undefined) await run(["network", "connect", "--alias", `${name}.${BOX_DNS_SUFFIX}`, control, name]);
        } catch (err) {
          await run(["stop", "-t", "10", name]).catch(() => "");
          if (ip !== undefined) await egressProxy.drop(ip).catch(() => undefined);
          throw err;
        }
        boxIps.set(name, ip);
      }
      const [listing] = await inspect([name]);
      let url: string | undefined;
      try {
        url = placement !== undefined && spec.port !== undefined ? `http://${name}.${BOX_DNS_SUFFIX}:${spec.port}` : await boxUrl(spec, name);
      } catch (err) {
        await stopBox(name);
        throw err;
      }
      const ip = boxIps.get(name);
      return { name, backend: "docker", createdAt: listing?.createdAt ?? Date.now(), maxMinutes, ...(url !== undefined ? { url } : {}), ...(ip !== undefined ? { egressSourceIp: ip } : {}) };
    },
    async status(name) {
      const [listing] = await inspect([name]);
      return listing;
    },
    async list(purpose) {
      const names = (await run(["ps", "-a", "--no-trunc", "--filter", `label=${DOCKER_BOX_LABEL}=${purpose}`, "--format", "{{.Names}}"]))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      return await inspect(names);
    },
    stop: stopBox,
    async forget(key) {
      const volume = dockerVolumeName(key);
      await stopOnVolume(volume);
      await run(["volume", "rm", "-f", volume]);
    },
  };
}

export const justBashBoxBackend: LongLivedBoxBackend = {
  backend: "justbash",
  metered: false,
  maxMinutesCeiling: 0,
  unavailable:
    "this deployment's sandbox backend is just-bash, which runs inside the app process and cannot run a long-lived box (no VM, no container, no browser). Declare `sandbox.selfHostBackend: \"docker\"` or run on Vercel Sandbox",
  async open() {
    throw new Error(justBashBoxBackend.unavailable);
  },
  async status() {
    return undefined;
  },
  async list() {
    return [];
  },
  async stop() {
  },
};

export function selectLongLivedBoxBackend(): LongLivedBoxBackend {
  const backend = resolveSandboxBackend();
  if (backend === "vercel") return createVercelBoxBackend();
  if (boxEgressBehindProxy()) return createDockerBoxBackend(defaultDockerRunner, undefined, liveDockerBoxEgressProxy());
  return backend === "justbash" ? justBashBoxBackend : createDockerBoxBackend();
}

export function registerLongLivedBoxes(): string {
  const backend = selectLongLivedBoxBackend();
  registerLongLivedBoxBackend(backend);
  return backend.backend;
}
