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
import { overrideSettingsForTest, resetSettingsForTest, type LogShipSetting } from "../agent/settings/settings.js";
import { pinSuiteStore } from "./_suite-store.js";

pinSuiteStore("observability");

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
  overrideSettingsForTest({ observability: { logShip: { url: "" } } });
}
function ship(cfg: LogShipSetting): void {
  overrideSettingsForTest({ observability: { logShip: cfg } });
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

  ok(!logShipEnabled(), "an empty observability.logShip.url → shipping disabled");
  enqueue(buildRecord("info", "test", "hello"));
  ok(__queueLengthForTest() === 0, "enqueue is a no-op when disabled");

  const logBefore = console.log;
  installConsoleCapture();
  ok(console.log === logBefore, "console capture is a no-op when disabled (console.log untouched)");

  oeLogger("gating").info("still fine to call the structured API");
  await flushLogShip();
  ok(calls.length === 0, "nothing is ever fetched when disabled");

  process.env.OE_LOG_SHIP_URL = "https://ingest.example.test/v1";
  __resetLogShipForTest({ fetchImpl: impl });
  ok(!logShipEnabled(), "🔴 a stale OE_LOG_SHIP_URL in the environment does not enable shipping");
  enqueue(buildRecord("info", "test", "hello"));
  await flushLogShip();
  ok(calls.length === 0 && __queueLengthForTest() === 0, "…and nothing is queued or fetched");
  clearShipEnv();
}

{
  clearShipEnv();
  ship({ url: "https://ingest.example.test/v1", service: "oe-test" });
  __resetLogShipForTest();

  const rec = buildRecord("warn", "shape", "the message", {
    fields: { requestId: "r-1", surfaceKey: "slack/T1/C1", component: "attacker-override" },
  });
  ok(rec.level === "warn" && rec.component === "shape" && rec.message === "the message", "reserved keys win over caller fields");
  ok(rec.requestId === "r-1", "caller fields ride along");
  ok(rec.surfaceKey === "slack/T1/C1", "explicit surfaceKey field is honoured");
  ok(rec.service === "oe-test", "service stamp comes from observability.logShip.service");
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
  ship({ url: "https://ingest.example.test/v1", tokenHeader: "X-Custom-Auth" });
  process.env.OE_LOG_SHIP_TOKEN = "Bearer xaat-123";
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
  ok(calls[0].headers["X-Custom-Auth"] === "Bearer xaat-123", "configured token header name (setting) and value (operator secret) applied");
  ok(calls[0].url === "https://ingest.example.test/v1", "ships to the configured URL");

  enqueue(buildRecord("info", "batch", "four"));
  ok(calls.length === 1, "single record waits for the timer");
  await sleep(60);
  ok(calls.length === 2 && calls[1].body[0].message === "four", "the flush timer flushes the stragglers");
  ok(__queueLengthForTest() === 0, "queue empty after flushes");
}

{
  clearShipEnv();
  ship({ url: "https://ingest.example.test/v1" });
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
  ship({ url: "https://ingest.example.test/v1" });
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

  ship({ url: "https://ingest.example.test/v1" });
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

{
  clearShipEnv();
  ship({ url: "https://ingest.example.test/v1" });
  const { calls, impl } = fakeFetch();
  __resetLogShipForTest({ fetchImpl: impl });
  enqueue(buildRecord("info", "token", "before the secret exists"));
  await flushLogShip();
  ok(calls.length === 1 && calls[0]!.headers.authorization === undefined, "no secret anywhere: the batch ships with no auth header");
  process.env.OE_LOG_SHIP_TOKEN = "Bearer later-token";
  enqueue(buildRecord("info", "token", "after the secret exists"));
  await flushLogShip();
  ok(calls.length === 2 && calls[1]!.headers.authorization === "Bearer later-token", "🔴 a secret that appears later reaches the NEXT flush (no process-lifetime memo)");
  clearShipEnv();
  __resetLogShipForTest();
}

{
  clearShipEnv();
  const { calls, impl } = fakeFetch();
  resetSettingsForTest();
  __resetLogShipForTest({ fetchImpl: impl, batchMax: 3, flushMs: 5000 });
  const realLog = console.log;
  const printed: string[] = [];
  console.log = ((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  }) as typeof console.log;
  try {
    installConsoleCapture();
    ok(console.log !== realLog && printed.length === 0, "🔴 pending: the capture installs before the settings register");
    console.log("[open-everywhere:boot] first line");
    console.log("[open-everywhere:boot] second line");
    ok(printed.length === 2, "pending: the console still prints every line");
    ok(__queueLengthForTest() === 2, "pending: each line waits in the bounded queue");
    await flushLogShip();
    ok(calls.length === 0, "🔴 pending: NOTHING is sent before the registration decides");

    ship({ url: "https://ingest.example.test/v1", service: "acme-oe" });
    console.log("[open-everywhere:boot] third line");
    await sleep(5);
    ok(calls.length === 1 && calls[0].body.length === 3, "🔴 registered with a URL: the lines logged before the registration ship");
    ok(calls[0].body.every((r) => r.service === "acme-oe"), "…carrying the registered service stamp, not the default");
  } finally {
    __resetLogShipForTest();
    console.log = realLog;
  }

  const quiet = fakeFetch();
  resetSettingsForTest();
  __resetLogShipForTest({ fetchImpl: quiet.impl });
  enqueue(buildRecord("info", "boot", "before registration"));
  ok(__queueLengthForTest() === 1, "pending: a record waits");
  clearShipEnv();
  ok(!logShipEnabled(), "registered with no URL: shipping is off");
  ok(__queueLengthForTest() === 0, "…and the waiting record is dropped, never sent");
  await flushLogShip();
  ok(quiet.calls.length === 0, "…and nothing is fetched");
  __resetLogShipForTest();
  resetSettingsForTest();
}

console.log(`\n✓ observability: ${n} assertions passed (config gating + record shaping + console parse + batching/headers + failure swallowing + capture/no-double-ship + boot-order pending)\n`);

// proves: SET-101
