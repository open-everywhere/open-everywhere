import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";

import { giveIdleCloseToClient } from "../tests/integration/fork-host-keepalive.js";
import { reserveEphemeralPort } from "./ephemeral-port.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(handler: Handler, fix: boolean): Promise<{ base: string; server: HttpServer }> {
  const reserved = await reserveEphemeralPort();
  ok(reserved.adoptedListener() === undefined, "adoptedListener() is undefined before the handoff");
  let server!: HttpServer;
  await reserved.bindListenerOnReservation(async () => {
    server = createHttpServer(handler);
    server.listen({ port: reserved.port, host: "127.0.0.1", exclusive: true });
  });
  ok(reserved.adoptedListener() === server, "adoptedListener() is the server whose listen() adopted the socket");
  if (fix) giveIdleCloseToClient(reserved.adoptedListener());
  return { base: `http://127.0.0.1:${reserved.port}`, server };
}

function stallPastIdleWindow(server: HttpServer): void {
  const buffer = (server as unknown as { keepAliveTimeoutBuffer?: number }).keepAliveTimeoutBuffer ?? 0;
  const until = Date.now() + 5_000 + buffer + 500;
  while (Date.now() < until) {
  }
}

async function secondRequest(base: string, server: HttpServer, stall: boolean): Promise<{ status?: number; code?: string; message?: string }> {
  const first = await fetch(base, { method: "POST", body: "one" });
  await first.text();
  ok(first.status === 200, `the first request answers 200 (got ${first.status})`);
  await new Promise((r) => setTimeout(r, 50));
  if (stall) stallPastIdleWindow(server);
  try {
    const second = await fetch(base, { method: "POST", body: "two" });
    await second.text();
    return { status: second.status };
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    return { code: cause?.code, message: `${(e as Error).message} — ${cause?.message ?? ""}` };
  }
}

const echoOk: Handler = (req, res) => {
  req.resume();
  req.on("end", () => res.end("ok"));
};

async function closeAll(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

async function main(): Promise<void> {
  {
    const { base, server } = await serve(echoOk, false);
    const out = await secondRequest(base, server, true);
    ok(out.code === "ECONNRESET", `① the default server resets the reused socket after a stalled loop (got ${JSON.stringify(out)})`);
    await closeAll(server);
  }

  {
    const { base, server } = await serve(echoOk, true);
    ok(server.keepAliveTimeout === 0, "② giveIdleCloseToClient turns the server's idle close off");
    const out = await secondRequest(base, server, true);
    ok(out.status === 200, `② the reused socket recovers after a stalled loop (got ${JSON.stringify(out)})`);
    await closeAll(server);
  }

  {
    let calls = 0;
    const { base, server } = await serve((req, res) => {
      req.resume();
      req.on("end", () => {
        calls++;
        res.statusCode = calls === 1 ? 200 : 503;
        res.end(calls === 1 ? "ok" : "unavailable");
      });
    }, true);
    const out = await secondRequest(base, server, false);
    ok(out.status === 503, `③ a 503 reaches the caller as a 503 (got ${JSON.stringify(out)})`);
    ok(calls === 2, `③ the handler ran once per request, so nothing retried the 503 (calls=${calls})`);
    await closeAll(server);
  }

  {
    let calls = 0;
    const { base, server } = await serve((req, res) => {
      calls++;
      if (calls === 1) return echoOk(req, res);
      req.socket.resetAndDestroy();
    }, true);
    const out = await secondRequest(base, server, false);
    ok(out.status === undefined && out.code !== undefined, `④ a real reset still fails the fetch (got ${JSON.stringify(out)})`);
    ok(calls === 2, `④ nothing retried the reset request (calls=${calls})`);
    await closeAll(server);
  }

  {
    let threw = "";
    try {
      giveIdleCloseToClient(createNetServer());
    } catch (e) {
      threw = (e as Error).message;
    }
    ok(threw.startsWith("fork-host-keepalive:"), "⑤ a plain net.Server listener throws instead of a silent skip");
    threw = "";
    try {
      giveIdleCloseToClient(undefined);
    } catch (e) {
      threw = (e as Error).message;
    }
    ok(threw.startsWith("fork-host-keepalive:"), "⑤ no adopted listener at all throws instead of a silent skip");
  }

  console.log(`✓ fork-host-keepalive: ${passed} checks passed`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
