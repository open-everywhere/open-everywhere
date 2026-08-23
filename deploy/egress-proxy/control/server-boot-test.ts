import assert from "node:assert/strict";
import net from "node:net";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";

type ControlProcess = ChildProcessByStdio<null, Readable, Readable>;

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.ts");
const TOKEN = "test-egress-token-1234567890";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

function spawnControl(env: Record<string, string | undefined>): ControlProcess {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "OE_EGRESS_PROXY_TOKEN") continue;
    if (v !== undefined) clean[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete clean[k];
    else clean[k] = v;
  }
  return spawn(process.execPath, ["--experimental-strip-types", SERVER], {
    env: clean,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface Exited {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runToExit(env: Record<string, string | undefined>, timeoutMs = 15_000): Promise<Exited> {
  const child = spawnControl(env);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  return await new Promise<Exited>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`control service did not exit within ${timeoutMs}ms (it should refuse to start)`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitForHealthz(base: string, child: ControlProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`control service exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`control service never became healthy within ${timeoutMs}ms`);
}

async function waitForStdout(getStdout: () => string, substring: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = getStdout();
    if (current.includes(substring)) return current;
    if (Date.now() >= deadline) return current;
    await new Promise((r) => setTimeout(r, 50));
  }
}

{
  for (const [value, label] of [
    [undefined, "unset"],
    ["", "empty"],
    ["   ", "whitespace-only"],
  ] as Array<[string | undefined, string]>) {
    const port = await freePort();
    const exited = await runToExit({
      OE_EGRESS_PROXY_TOKEN: value,
      OE_EGRESS_CONTROL_PORT: String(port),
      OE_EGRESS_CONTROL_HOST: "127.0.0.1",
    });
    ok(exited.code === 1, `${label} OE_EGRESS_PROXY_TOKEN → the control service exits 1 (refuses to start)`);
    ok(exited.stderr.includes("FATAL"), `${label} token → the failure is reported as FATAL on stderr`);
    ok(
      exited.stderr.includes("OE_EGRESS_PROXY_TOKEN"),
      `${label} token → the fatal names the env var the operator must set`,
    );
    ok(!exited.stdout.includes("listening on"), `${label} token → no listener was ever opened`);

    let refused = false;
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch {
      refused = true;
    }
    ok(refused, `${label} token → nothing is listening on the control port`);
  }
}

{
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawnControl({
    OE_EGRESS_PROXY_TOKEN: TOKEN,
    OE_EGRESS_CONTROL_PORT: String(port),
    OE_EGRESS_CONTROL_HOST: "127.0.0.1",
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += String(d)));

  try {
    await waitForHealthz(base, child);
    stdout = await waitForStdout(() => stdout, "auth required on /policy");
    ok(stdout.includes("auth required on /policy"), "the boot log states that /policy requires auth");

    const push = (headers: Record<string, string>, body: unknown) =>
      fetch(`${base}/policy`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    const policy = { policy: { allow: { "github.com": [] } }, sourceIp: "172.20.0.5" };

    const anon = await push({}, { policy: "allow-all", sourceIp: "172.20.0.5" });
    ok(anon.status === 401, "POST /policy without the token → 401 (the tokenless bypass is gone)");

    const wrong = await push({ authorization: `Bearer ${TOKEN}x` }, { policy: "allow-all", sourceIp: "172.20.0.5" });
    ok(wrong.status === 401, "POST /policy with a wrong token → 401");

    const noScheme = await push({ authorization: TOKEN }, { policy: "allow-all", sourceIp: "172.20.0.5" });
    ok(noScheme.status === 401, "POST /policy with the raw token (no `Bearer `) → 401");

    const beforeAcl = await fetch(`${base}/acl?src=172.20.0.5&host=github.com&method=CONNECT&path=-`);
    const before = (await beforeAcl.json()) as { allow: boolean };
    ok(before.allow === false, "after the rejected pushes the source is still deny-all (nothing was stored)");

    const good = await push({ authorization: `Bearer ${TOKEN}` }, policy);
    const goodBody = (await good.json()) as { ok?: boolean; sourceIp?: string };
    ok(good.status === 200 && goodBody.ok === true, "POST /policy with the token → 200");
    ok(goodBody.sourceIp === "172.20.0.5", "the authorised push is keyed by the body's explicit sourceIp");

    const aclRes = await fetch(`${base}/acl?src=172.20.0.5&host=github.com&method=CONNECT&path=-`);
    const acl = (await aclRes.json()) as { allow: boolean };
    ok(aclRes.status === 200 && acl.allow === true, "GET /acl from a loopback peer still answers (Squid helper path)");
    const aclDeny = await fetch(`${base}/acl?src=172.20.0.5&host=pastebin.test&method=CONNECT&path=-`);
    ok(((await aclDeny.json()) as { allow: boolean }).allow === false, "GET /acl still denies an unlisted host");

    const delAnon = await fetch(`${base}/policy?sourceIp=172.20.0.5`, { method: "DELETE" });
    ok(delAnon.status === 401, "DELETE /policy without the token → 401");
    const stillThere = await fetch(`${base}/acl?src=172.20.0.5&host=github.com&method=CONNECT&path=-`);
    ok(((await stillThere.json()) as { allow: boolean }).allow === true, "the unauthorised DELETE did not drop the policy");

    const delOk = await fetch(`${base}/policy?sourceIp=172.20.0.5`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    ok(delOk.status === 200, "DELETE /policy with the token → 200");

    const health = await fetch(`${base}/healthz`);
    ok(health.status === 200, "GET /healthz needs no token (the entrypoint readiness probe)");
  } finally {
    child.kill("SIGKILL");
  }
}

console.log(`\n✓ egress-proxy control server: ${n} assertions passed (boot refusal without a token + /policy bearer gate + /acl loopback path intact)\n`);
