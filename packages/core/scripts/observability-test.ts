import assert from "node:assert/strict";
import {
  buildRecord,
  parseConsoleArgs,
  shapeError,
  enqueue,
  flushLogShip,
  logShipEnabled,
  oeLogger,
  installConsoleCapture,
  droppedRecordCount,
  __resetLogShipForTest,
  __queueLengthForTest,
  type LogRecord,
} from "../agent/observability/ship.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const SHIP_ENV = [
  "OE_LOG_SHIP_URL",
  "OE_LOG_SHIP_TOKEN",
  "OE_LOG_SHIP_TOKEN_HEADER",
  "OE_LOG_SERVICE",
];
function clearShipEnv(): void {
  for (const key of SHIP_ENV) delete process.env[key];
}

function fakeFetch(status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: LogRecord[] }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as LogRecord[],
    });
    return { ok: status < 400, status } as Response;
  }) as typeof fetch;
  return { calls, impl };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

{
  clearShipEnv();
  const { calls, impl } = fakeFetch();
  __resetLogShipForTest({ fetchImpl: impl });

  ok(!logShipEnabled(), "no OE_LOG_SHIP_URL → shipping disabled");
  enqueue(buildRecord("info", "test", "hello"));
  ok(__queueLengthForTest() === 0, "enqueue is a no-op when disabled");

  const logBefore = console.log;
  installConsoleCapture();
  ok(console.log === logBefore, "console capture is a no-op when disabled (console.log untouched)");

  oeLogger("gating").info("still fine to call the structured API");
  await flushLogShip();
  ok(calls.length === 0, "nothing is ever fetched when disabled");
}

{
  clearShipEnv();
  process.env.OE_LOG_SHIP_URL = "https://ingest.example.test/v1";
  process.env.OE_LOG_SERVICE = "oe-test";
  __resetLogShipForTest();

  const rec = buildRecord("warn", "shape", "the message", {
    fields: { requestId: "r-1", surfaceKey: "slack/T1/C1", component: "attacker-override" },
  });
  ok(rec.level === "warn" && rec.component === "shape" && rec.message === "the message", "reserved keys win over caller fields");
  ok(rec.requestId === "r-1", "caller fields ride along");
  ok(rec.surfaceKey === "slack/T1/C1", "explicit surfaceKey field is honoured");
  ok(rec.service === "oe-test", "service stamp comes from OE_LOG_SERVICE");
  ok(typeof rec.env === "string" && rec.env.length > 0, "env stamp present");
  ok(!Number.isNaN(Date.parse(rec.ts)), "ts is a parseable ISO timestamp");

  const withErr = buildRecord("error", "shape", "boom", { err: new Error("kapow") });
  ok(withErr.error?.message === "kapow" && typeof withErr.error?.stack === "string", "Error → name/message/stack shaped");
  ok(shapeError("just a string").name === "NonError", "non-Error caught values are shaped, not dropped");
  ok(shapeError({ code: 7 }).message.includes("7"), "non-Error object message keeps the payload");
}

{
  const tagged = parseConsoleArgs(["[open-everywhere:model-routing] chat: no surface at model-call time"]);
  ok(tagged.component === "model-routing", "component parsed from the [open-everywhere:x] prefix");
  ok(tagged.message === "chat: no surface at model-call time", "prefix stripped from the shipped message");

  const untagged = parseConsoleArgs(["something eve printed", 42]);
  ok(untagged.component === "console" && untagged.message === "something eve printed 42", "untagged lines ship under component 'console' with args stringified");

  const boom = new Error("relay down");
  const withErr = parseConsoleArgs(["[open-everywhere:approvals] failed softly:", boom]);
  ok(withErr.err === boom, "first Error argument captured as the structured error");
  ok(withErr.message.includes("relay down"), "error message still lands in the flat message");

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  ok(parseConsoleArgs([cyclic]).message.length > 0, "unstringifiable args degrade to String(), never throw");
}

{
  clearShipEnv();
  process.env.OE_LOG_SHIP_URL = "https://ingest.example.test/v1";
  process.env.OE_LOG_SHIP_TOKEN = "Bearer xaat-123";
  process.env.OE_LOG_SHIP_TOKEN_HEADER = "X-Custom-Auth";
  const { calls, impl } = fakeFetch();
  __resetLogShipForTest({ fetchImpl: impl, batchMax: 3, flushMs: 20 });

  enqueue(buildRecord("info", "batch", "one"));
  enqueue(buildRecord("info", "batch", "two"));
  ok(calls.length === 0 && __queueLengthForTest() === 2, "below batchMax → queued, not shipped");
  enqueue(buildRecord("info", "batch", "three"));
  await sleep(5);
  ok(calls.length === 1, "hitting batchMax flushes immediately");
  ok(calls[0].body.length === 3 && calls[0].body[2].message === "three", "batch ships as a JSON array in order");
  ok(calls[0].headers["content-type"] === "application/json", "content-type set");
  ok(calls[0].headers["X-Custom-Auth"] === "Bearer xaat-123", "configured token header name/value applied");
  ok(calls[0].url === "https://ingest.example.test/v1", "ships to the configured URL");

  enqueue(buildRecord("info", "batch", "four"));
  ok(calls.length === 1, "single record waits for the timer");
  await sleep(60);
  ok(calls.length === 2 && calls[1].body[0].message === "four", "the flush timer flushes the stragglers");
  ok(__queueLengthForTest() === 0, "queue empty after flushes");
}

{
  clearShipEnv();
  process.env.OE_LOG_SHIP_URL = "https://ingest.example.test/v1";
  const rejecting = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  __resetLogShipForTest({ fetchImpl: rejecting });

  enqueue(buildRecord("error", "fail", "will not land"));
  await flushLogShip();
  ok(true, "rejecting fetch never propagates out of flush");
  ok(__queueLengthForTest() === 0, "failed batch is dropped, not re-queued (bounded memory)");
  ok(droppedRecordCount() === 1, "dropped records are counted");

  const { impl } = fakeFetch(401);
  __resetLogShipForTest({ fetchImpl: impl });
  enqueue(buildRecord("info", "fail", "unauthorized"));
  await flushLogShip();
  ok(droppedRecordCount() === 1, "non-ok status drops the batch without throwing");

  const healthy = fakeFetch();
  __resetLogShipForTest({ fetchImpl: healthy.impl });
  enqueue(buildRecord("info", "fail", "recovered"));
  await flushLogShip();
  ok(healthy.calls.length === 1 && healthy.calls[0].body[0].message === "recovered", "shipping recovers on the next batch");
}

{
  clearShipEnv();
  process.env.OE_LOG_SHIP_URL = "https://ingest.example.test/v1";
  const { calls, impl } = fakeFetch();
  __resetLogShipForTest({ fetchImpl: impl, flushMs: 5000 });

  const printed: string[] = [];
  const realLog = console.log;
  console.log = ((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  }) as typeof console.log;
  try {
    installConsoleCapture();
    const wrapped = console.log;
    installConsoleCapture();
    ok(console.log === wrapped, "installConsoleCapture is idempotent");

    console.log("[open-everywhere:egress] policy applied");
    ok(printed.length === 1 && printed[0].includes("[open-everywhere:egress]"), "captured console still prints the identical line");
    ok(__queueLengthForTest() === 1, "captured console line queued a structured record");

    await flushLogShip();
    const rec = calls[0].body[0];
    ok(rec.component === "egress" && rec.message === "policy applied" && rec.level === "info", "captured record carries parsed component + clean message");
  } finally {
    __resetLogShipForTest({ fetchImpl: impl });
    console.log = realLog;
  }

  process.env.OE_LOG_SHIP_URL = "https://ingest.example.test/v1";
  const second = fakeFetch();
  __resetLogShipForTest({ fetchImpl: second.impl });
  installConsoleCapture();
  try {
    const log = oeLogger("structured");
    log.error("turn dropped", new Error("gate misfire"), { surfaceKey: "slack/T1/C9", turnId: "t-1" });
    ok(__queueLengthForTest() === 1, "structured error call ships exactly one record (no capture double-ship)");
    await flushLogShip();
    const rec = second.calls[0].body[0];
    ok(rec.level === "error" && rec.component === "structured", "structured record level/component");
    ok(rec.error?.message === "gate misfire" && typeof rec.error?.stack === "string", "structured error carries the stack");
    ok(rec.surfaceKey === "slack/T1/C9" && rec.turnId === "t-1", "structured fields (surfaceKey, context) ride the record");
  } finally {
    __resetLogShipForTest();
    clearShipEnv();
  }
}

console.log(`\n✓ observability: ${n} assertions passed (env gating + record shaping + console parse + batching/headers + failure swallowing + capture/no-double-ship)\n`);
