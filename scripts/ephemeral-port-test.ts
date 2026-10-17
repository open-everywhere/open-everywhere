import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, Server } from "node:net";
import { HANDOFF_MISSED_PREFIX, reserveEphemeralPort } from "./ephemeral-port.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

async function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function siblingProcessCanBind(port: number): boolean {
  const script =
    'const s=require("node:net").createServer();s.once("error",(e)=>process.exit(e.code==="EADDRINUSE"?3:4));' +
    `s.listen(${port},"127.0.0.1",()=>s.close(()=>process.exit(0)));`;
  const run = spawnSync(process.execPath, ["-e", script], { timeout: 20_000 });
  if (run.status !== 0 && run.status !== 3) throw new Error(`sibling bind probe died: status=${run.status} signal=${run.signal}`);
  return run.status === 0;
}

function listenLikeSrvx(server: HttpServer, port: number): Promise<"listening" | string> {
  return new Promise((resolve) => {
    server.once("listening", () => resolve("listening"));
    server.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? String(err)));
    server.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}

async function closeHttp(server: HttpServer): Promise<void> {
  if (server.listening) await new Promise<void>((res) => server.close(() => res()));
}

async function main(): Promise<void> {
  const one = await reserveEphemeralPort();
  ok(Number.isInteger(one.port) && one.port > 0 && one.port < 65536, "reserved port is a valid TCP port number");
  await one.release();

  const COUNT = 25;
  const reserved = await Promise.all(Array.from({ length: COUNT }, () => reserveEphemeralPort()));
  const ports = new Set(reserved.map((r) => r.port));
  ok(ports.size === COUNT, `${COUNT} concurrent reservations returned ${COUNT} distinct ports (got ${ports.size})`);

  const held = await reserveEphemeralPort();
  const collided = await tryBind(held.port);
  ok(collided === false, "a second bind to a still-held reserved port is refused (the port is exclusively ours until release)");

  await held.release();
  const freedNow = await tryBind(held.port);
  ok(freedNow === true, "after release() the same port can be bound by someone else");

  await held.release();
  ok(true, "a second release() call does not throw");

  for (const r of reserved) await r.release();

  {
    const r = await reserveEphemeralPort();
    const ours = createHttpServer((_req, res) => res.end("ours"));
    let siblingBound: boolean | undefined;
    let ourListen: string | undefined;
    await r.bindListenerOnReservation(async () => {
      await new Promise((res) => setImmediate(res));
      siblingBound = siblingProcessCanBind(r.port);
      ourListen = await listenLikeSrvx(ours, r.port);
    });
    ok(siblingBound === false, "a sibling bind between the reservation and the real listen is refused (OPE-2555)");
    ok(ourListen === "listening", `the real listener binds the reserved port (got ${ourListen})`);
    const address = ours.address();
    ok(address !== null && typeof address === "object" && address.port === r.port, "the real listener sits on the reserved port");
    const body = await fetch(`http://127.0.0.1:${r.port}/`).then((x) => x.text());
    ok(body === "ours", `the reserved port answers with OUR host (got ${JSON.stringify(body)})`);
    ok(!siblingProcessCanBind(r.port), "after the handoff a sibling bind is still refused (the real listener holds the port)");
    await r.release();
    ok((await tryBind(r.port)) === false, "release() after a handoff does not close the real listener's socket");
    await closeHttp(ours);
    ok((await tryBind(r.port)) === true, "closing the real listener frees the port — no leak");
    ok(siblingProcessCanBind(r.port), "a sibling bind succeeds once the port is free (the probe's positive control)");
  }

  {
    const original = Server.prototype.listen;
    const r = await reserveEphemeralPort();
    const other = createServer();
    const ours = createHttpServer();
    let otherPort: number | undefined;
    await r.bindListenerOnReservation(async () => {
      await new Promise<void>((res) => other.listen(0, "127.0.0.1", () => res()));
      const a = other.address();
      otherPort = a !== null && typeof a === "object" ? a.port : undefined;
      ok(Server.prototype.listen !== original, "listen() is intercepted while the bind runs");
      await new Promise<void>((res) => ours.listen(r.port, "127.0.0.1", () => res()));
    });
    ok(otherPort !== undefined && otherPort !== r.port, "an unrelated listen(0) passes through and gets its own port");
    ok(Server.prototype.listen === original, "listen() is restored after the handoff");
    const a = ours.address();
    ok(a !== null && typeof a === "object" && a.port === r.port, "the positional listen(port, host, cb) form adopts the reserved socket");
    await closeHttp(ours);
    await new Promise<void>((res) => other.close(() => res()));
  }

  {
    const original = Server.prototype.listen;
    const r = await reserveEphemeralPort();
    const ours = createHttpServer();
    let wrapper: typeof Server.prototype.listen | undefined;
    await r.bindListenerOnReservation(async () => {
      const inner = Server.prototype.listen;
      wrapper = function (this: Server, ...args: unknown[]) {
        return (inner as (...a: unknown[]) => Server).apply(this, args);
      } as typeof Server.prototype.listen;
      Server.prototype.listen = wrapper;
      await new Promise<void>((res) => ours.listen(r.port, "127.0.0.1", () => res()));
    });
    ok(wrapper !== undefined && Server.prototype.listen === wrapper, "a wrapper installed over the interceptor is left in place");
    const a = ours.address();
    ok(a !== null && typeof a === "object" && a.port === r.port, "a listen through the wrapper still adopts the reserved socket");
    Server.prototype.listen = original;
    await closeHttp(ours);
  }

  {
    const original = Server.prototype.listen;
    const r = await reserveEphemeralPort();
    let message = "";
    try {
      await r.bindListenerOnReservation(async () => undefined, 50);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    ok(message.startsWith(HANDOFF_MISSED_PREFIX), `a missed handoff rejects with the named error (got ${JSON.stringify(message)})`);
    ok(Server.prototype.listen === original, "listen() is restored after a missed handoff");
    ok((await tryBind(r.port)) === true, "a missed handoff releases the reservation");
  }

  {
    const original = Server.prototype.listen;
    const r = await reserveEphemeralPort();
    let threw = false;
    try {
      await r.bindListenerOnReservation(async () => {
        throw new Error("bundle import failed");
      });
    } catch {
      threw = true;
    }
    ok(threw, "a throwing bind rejects the handoff");
    ok(Server.prototype.listen === original, "listen() is restored after a throwing bind");
    ok((await tryBind(r.port)) === true, "a throwing bind releases the reservation");
  }

  for (const caller of ["tests/integration/harness.ts", "tests/integration/prewarm.ts"]) {
    const src = readFileSync(new URL(`../${caller}`, import.meta.url), "utf8");
    ok(src.includes(".bindListenerOnReservation("), `${caller} binds the bundle's listener through bindListenerOnReservation`);
    ok(!/\.release\(/.test(src), `${caller} never calls release() on the reservation (the port must not be free before the real bind)`);
  }

  console.log(`✓ ephemeral-port: ${passed} assertions passed (distinct ports under concurrency, held-until-release exclusivity, no leak, sibling-proof handoff)`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
