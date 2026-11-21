import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  bindSessionBox,
  currentSessionId,
  getSettings,
  resolveLongLivedBoxBackend,
  unbindSessionBox,
  type BoxSpec,
  type LongLivedBoxBackend,
} from "@open-everywhere/core/agent/adapter-api.js";

export interface BoxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type BoxExec = (name: string, command: string, opts?: { readonly stdin?: Uint8Array; readonly abortSignal?: AbortSignal }) => Promise<BoxExecResult>;

const defaultBoxExec: BoxExec = async (name, command, opts) =>
  await new Promise<BoxExecResult>((resolve, reject) => {
    const bin = process.env.EVE_DOCKER_PATH?.trim() || "docker";
    const stdin = opts?.stdin;
    const child = spawn(bin, ["exec", "-i", name, "sh", "-c", command], { stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"], ...(opts?.abortSignal !== undefined ? { signal: opts.abortSignal } : {}) });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => reject(new Error(`docker exec failed: ${e.message}`)));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    if (stdin !== undefined && child.stdin !== null) Readable.from([Buffer.from(stdin)]).pipe(child.stdin);
  });

export interface BoxSandbox {
  readonly id: string;
  run(options: { readonly command: string; readonly abortSignal?: AbortSignal }): Promise<BoxExecResult>;
}

export const QA_BOX_MAX_MINUTES = 60;
const QA_BOX_IDLE_MS = 10 * 60_000;
const QA_BOX_CAP_MARGIN_MS = 2 * 60_000;

export interface QaBoxDriverDeps {
  readonly backend?: () => LongLivedBoxBackend;
  readonly exec?: BoxExec;
  readonly bind?: (sessionId: string, ip: string) => Promise<void>;
  readonly unbind?: (sessionId: string, ip: string) => void;
  readonly image?: () => string;
  readonly idleMs?: number;
  readonly capMs?: number;
}

export function qaBoxSpec(sessionId: string, image: string): BoxSpec {
  return {
    purpose: "browser-qa",
    ref: `qa-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`,
    image,
    command: ["sleep", "infinity"],
    vcpus: 1,
    memoryMb: 2048,
    shmMb: 1024,
    user: "pwuser",
    maxMinutes: QA_BOX_MAX_MINUTES,
    env: {},
    egress: { allow: [] },
  };
}

interface LiveBox {
  readonly name: string;
  readonly ip: string;
  timer?: ReturnType<typeof setTimeout>;
  cap?: ReturnType<typeof setTimeout>;
}

export interface QaBoxDriver {
  sandboxFor(sessionId: string): Promise<BoxSandbox>;
  readFile(sessionId: string, path: string): Promise<Uint8Array | undefined>;
  writeFile(sessionId: string, path: string, bytes: Uint8Array): Promise<void>;
  close(sessionId: string): Promise<void>;
}

export const TRUST_EGRESS_CA =
  'if [ -n "$OE_BOX_EGRESS_CA" ]; then d="$HOME/.pki/nssdb"; mkdir -p "$d" && { [ -f "$d/cert9.db" ] || certutil -d "sql:$d" -N --empty-password; } && ' +
  'printf "%s" "$OE_BOX_EGRESS_CA" > /tmp/oe-egress-ca.crt && certutil -d "sql:$d" -A -t "C,," -n oe-egress -i /tmp/oe-egress-ca.crt; fi';

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function createQaBoxDriver(deps: QaBoxDriverDeps = {}): QaBoxDriver {
  const backend = deps.backend ?? resolveLongLivedBoxBackend;
  const exec = deps.exec ?? defaultBoxExec;
  const bind = deps.bind ?? bindSessionBox;
  const unbind = deps.unbind ?? unbindSessionBox;
  const image = deps.image ?? (() => getSettings().browser.boxImage.trim());
  const idleMs = deps.idleMs ?? QA_BOX_IDLE_MS;
  const capMs = deps.capMs ?? QA_BOX_MAX_MINUTES * 60_000 - QA_BOX_CAP_MARGIN_MS;
  const boxes = new Map<string, Promise<LiveBox>>();

  async function open(sessionId: string): Promise<LiveBox> {
    const b = backend();
    if (b.unavailable !== undefined) throw new Error(b.unavailable);
    if (b.enforcesHostAllowList !== true) {
      throw new Error(`the ${b.backend} box backend cannot hold a browser container to the session's hosts, so the browser does not open here`);
    }
    const img = image();
    if (img === "") throw new Error("browser.boxImage is empty, so there is no browser image to start");
    const opened = await b.open(qaBoxSpec(sessionId, img));
    const ip = opened.egressSourceIp;
    try {
      if (ip === undefined) throw new Error("the box backend gave no IP for the browser container, so the egress proxy cannot hold it to the session's policy");
      await bind(sessionId, ip);
      const trusted = await exec(opened.name, TRUST_EGRESS_CA);
      if (trusted.exitCode !== 0) throw new Error("the browser container could not trust the egress proxy's CA, so a site the proxy decrypts would fail");
    } catch (err) {
      await b.stop(opened.name).catch(() => undefined);
      throw err;
    }
    const box: LiveBox = { name: opened.name, ip };
    box.cap = setTimeout(() => void close(sessionId), capMs);
    box.cap.unref?.();
    return box;
  }

  function touch(sessionId: string, box: LiveBox): void {
    if (box.timer !== undefined) clearTimeout(box.timer);
    box.timer = setTimeout(() => void close(sessionId), idleMs);
    box.timer.unref?.();
  }

  async function live(sessionId: string): Promise<LiveBox> {
    let pending = boxes.get(sessionId);
    if (pending === undefined) {
      pending = open(sessionId);
      boxes.set(sessionId, pending);
      pending.catch(() => boxes.delete(sessionId));
    }
    const box = await pending;
    const listing = await backend().status(box.name).catch(() => undefined);
    if (listing === undefined || listing.status !== "running") {
      await close(sessionId);
      return await live(sessionId);
    }
    touch(sessionId, box);
    return box;
  }

  async function close(sessionId: string): Promise<void> {
    const pending = boxes.get(sessionId);
    if (pending === undefined) return;
    boxes.delete(sessionId);
    let box: LiveBox;
    try {
      box = await pending;
    } catch {
      return;
    }
    if (box.timer !== undefined) clearTimeout(box.timer);
    if (box.cap !== undefined) clearTimeout(box.cap);
    unbind(sessionId, box.ip);
    await backend().stop(box.name);
  }

  return {
    async sandboxFor(sessionId) {
      const box = await live(sessionId);
      return {
        id: box.name,
        run: async ({ command, abortSignal }) => await exec(box.name, command, abortSignal !== undefined ? { abortSignal } : undefined),
      };
    },
    async readFile(sessionId, path) {
      const box = await live(sessionId);
      const r = await exec(box.name, `base64 < ${shq(path)}`);
      if (r.exitCode !== 0) return undefined;
      return Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
    },
    async writeFile(sessionId, path, bytes) {
      const box = await live(sessionId);
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
      const r = await exec(box.name, `mkdir -p ${shq(dir)} && cat > ${shq(path)}`, { stdin: bytes });
      if (r.exitCode !== 0) throw new Error(`could not copy ${path} into the browser container`);
    },
    close,
  };
}

interface ToolCtx {
  getSandbox(): Promise<{ readBinaryFile?(o: { path: string }): PromiseLike<Uint8Array | null>; writeBinaryFile?(o: { path: string; content: Uint8Array }): PromiseLike<void> } | null | undefined>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function boxedBrowserExecute(
  toolName: string,
  execute: (input: any, ctx: any) => any,
  driver: QaBoxDriver,
): (input: any, ctx: any) => Promise<any> {
  return async (input, ctx) => {
    const sessionId = currentSessionId(ctx);
    if (sessionId === undefined) throw new Error("the browser container is per session, and this call carries no session id");
    const real = ctx as ToolCtx;
    if (toolName === "browser_upload" && Array.isArray(input?.files)) {
      const sandbox = await real.getSandbox();
      for (const f of input.files as string[]) {
        const bytes = await sandbox?.readBinaryFile?.({ path: f });
        if (bytes === null || bytes === undefined) throw new Error(`the file ${f} is not in the session sandbox`);
        await driver.writeFile(sessionId, f, bytes);
      }
    }
    const boxed = new Proxy(ctx as object, {
      get(target, prop) {
        if (prop === "getSandbox") return async () => await driver.sandboxFor(sessionId);
        return Reflect.get(target, prop, target);
      },
    });
    const output = await execute(input, boxed);
    const path = toolName === "browser_screenshot" && output !== null && typeof output === "object" ? (output as { path?: unknown }).path : undefined;
    if (typeof path === "string") {
      const bytes = await driver.readFile(sessionId, path);
      const sandbox = await real.getSandbox();
      if (bytes !== undefined && sandbox?.writeBinaryFile !== undefined) await sandbox.writeBinaryFile({ path, content: bytes });
    }
    return output;
  };
}
