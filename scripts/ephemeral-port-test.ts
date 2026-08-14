import { createServer } from "node:net";
import { reserveEphemeralPort } from "./ephemeral-port.js";

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

  console.log(`✓ ephemeral-port: ${passed} assertions passed (distinct ports under concurrency, held-until-release exclusivity, no leak)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
