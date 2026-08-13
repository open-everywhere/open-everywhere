import assert from "node:assert/strict";

import { renderSmokeReport, runWebhookSmoke, rowDeliveryId, type SmokeResult } from "./deploy/smoke-lib.js";
import { WEBHOOK_ID_HEADER, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER, WebhookDriver } from "../packages/core/scripts/e2e/webhook.js";
import type { AuditWireEntry } from "../packages/core/scripts/e2e/audit-read.js";

let checks = 0;
const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  checks++;
  try {
    await fn();
  } catch (err) {
    failures.push(`${label}\n      ${String(err instanceof Error ? err.message : err)}`);
  }
}

const TARGET = "https://oe.example.test";
const HOOK = "e2e-smoke";
const SURFACE = "C0EXCHAN003";

interface StubOpts {
  readonly signedStatus?: number;
  readonly unsignedStatus?: number;
  readonly fire?: "fired" | "declined" | "none";
  readonly reply?: boolean;
  readonly replySurface?: string;
  readonly fireUnsigned?: boolean;
  readonly auditStatus?: number;
  readonly decoys?: readonly AuditWireEntry[];
}

interface Stub {
  readonly fetchImpl: Parameters<typeof runWebhookSmoke>[0]["fetchImpl"];
  readonly signedHeaders: Record<string, string>[];
  readonly unsignedHeaders: Record<string, string>[];
}

function row(action: string, over: Partial<AuditWireEntry> & { detail?: Record<string, unknown> } = {}): AuditWireEntry {
  return {
    ts: new Date().toISOString(),
    org: "default",
    platform: "slack",
    workspace: "T0EXAMPLE",
    surface: SURFACE,
    action,
    ...over,
  };
}

function makeStub(opts: StubOpts = {}): Stub {
  const rows: AuditWireEntry[] = [...(opts.decoys ?? [])];
  const signedHeaders: Record<string, string>[] = [];
  const unsignedHeaders: Record<string, string>[] = [];
  const fetchImpl: Stub["fetchImpl"] = async (url, init) => {
    if (url.startsWith(`${TARGET}/webhooks/`)) {
      const headers = init.headers;
      const deliveryId = headers[WEBHOOK_ID_HEADER];
      const isSigned = headers[WEBHOOK_SIGNATURE_HEADER] !== undefined;
      if (isSigned) {
        signedHeaders.push(headers);
        if ((opts.fire ?? "fired") !== "none") {
          rows.push(
            row(opts.fire === "declined" ? "webhook.declined" : "webhook.fired", {
              detail: { hookId: HOOK, deliveryId, ...(opts.fire === "declined" ? { reason: "over the spend cap" } : {}) },
            }),
          );
        }
        if (opts.reply !== false) {
          rows.push(
            row("reply.post", {
              ...(opts.replySurface !== undefined ? { surface: opts.replySurface } : {}),
              detail: { route: "terminal", chars: 42, sessionId: "sess-smoke" },
            }),
          );
        }
        return { status: opts.signedStatus ?? 200, text: async () => "ok" };
      }
      unsignedHeaders.push(headers);
      if (opts.fireUnsigned) rows.push(row("webhook.fired", { detail: { hookId: HOOK, deliveryId } }));
      return { status: opts.unsignedStatus ?? 401, text: async () => "unauthorized" };
    }
    if (url.startsWith(`${TARGET}/control/v1/audit`)) {
      const status = opts.auditStatus ?? 200;
      if (status !== 200) return { status, text: async () => "forbidden" };
      const wanted = new URL(url).searchParams.get("actions")?.split(",") ?? [];
      const entries = rows.filter((r) => wanted.length === 0 || wanted.includes(r.action));
      return { status: 200, text: async () => JSON.stringify({ entries }) };
    }
    throw new Error(`stub deployment got an unexpected request: ${url}`);
  };
  return { fetchImpl, signedHeaders, unsignedHeaders };
}

async function smoke(opts: StubOpts = {}, stub: Stub = makeStub(opts)): Promise<SmokeResult> {
  let clock = Date.parse("2026-08-13T12:00:00.000Z");
  return runWebhookSmoke({
    webhook: { targetUrl: TARGET, secret: "whsec_c2VjcmV0", hookId: HOOK },
    controlToken: "tok-read",
    fetchImpl: stub.fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => {},
    firedTimeoutMs: 10_000,
    replyTimeoutMs: 10_000,
    unsignedGraceMs: 1_000,
    pollIntervalMs: 1_000,
  });
}

function gate(result: SmokeResult, needle: string): { label: string; pass: boolean; detail: string } {
  const hit = result.gates.find((g) => g.label.includes(needle));
  assert.ok(hit, `no gate matching "${needle}" — gates were: ${result.gates.map((g) => g.label).join(" | ")}`);
  return hit;
}

await check("a healthy deployment passes every deterministic gate, and each is present and true", async () => {
  const result = await smoke();
  assert.equal(result.ok, true, `expected ok; gates: ${JSON.stringify(result.gates)}`);
  assert.equal(gate(result, "signed webhook POST is accepted").pass, true);
  assert.equal(gate(result, "audits OUR delivery").pass, true);
  assert.equal(gate(result, "FIRED rather than being declined").pass, true);
  assert.equal(gate(result, "reply choke point").pass, true);
  assert.equal(gate(result, "unsigned webhook POST is refused").pass, true);
  assert.equal(gate(result, "leaves NO audit trace").pass, true);
  assert.equal(result.gates.length, 6, "the ladder is exactly six gates — a dropped rung is a silent coverage loss");
});

await check("the signed POST carries all three scheme headers; the unsigned one carries ONLY the id", async () => {
  const stub = makeStub();
  await smoke({}, stub);
  assert.equal(stub.signedHeaders.length, 1);
  const signed = stub.signedHeaders[0]!;
  assert.ok(signed[WEBHOOK_ID_HEADER], "signed delivery carries webhook-id");
  assert.ok(signed[WEBHOOK_TIMESTAMP_HEADER], "signed delivery carries webhook-timestamp");
  assert.match(signed[WEBHOOK_SIGNATURE_HEADER]!, /^v1,/, "signed delivery carries a v1, signature");
  const unsigned = stub.unsignedHeaders[0]!;
  assert.ok(unsigned[WEBHOOK_ID_HEADER], "the refused delivery still carries webhook-id — that is what makes the no-trace gate an EXACT join");
  assert.equal(unsigned[WEBHOOK_SIGNATURE_HEADER], undefined, "the refused delivery carries NO signature header");
  assert.equal(unsigned[WEBHOOK_TIMESTAMP_HEADER], undefined, "the refused delivery carries NO timestamp header");
  assert.notEqual(signed[WEBHOOK_ID_HEADER], unsigned[WEBHOOK_ID_HEADER], "the two legs mint DIFFERENT delivery ids");
});

await check("RED 1 — a signed delivery the ingress refuses fails the FIRST gate and stops the positive chain", async () => {
  const result = await smoke({ signedStatus: 500, fire: "none", reply: false });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "signed webhook POST is accepted").pass, false);
  assert.match(gate(result, "signed webhook POST is accepted").detail, /-> 500/);
  assert.equal(
    result.gates.some((g) => g.label.includes("audits OUR delivery")),
    false,
    "the row gates do not run once the POST itself was refused",
  );
  assert.equal(gate(result, "unsigned webhook POST is refused").pass, true);
});

await check("RED 2a — a 200 with no fire row fails the delivery-join gate", async () => {
  const result = await smoke({ fire: "none", reply: false });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "signed webhook POST is accepted").pass, true, "the ingress DID ack — that is what makes this red interesting");
  assert.equal(gate(result, "audits OUR delivery").pass, false);
  assert.match(gate(result, "audits OUR delivery").detail, /no webhook\.fired\/webhook\.declined row carrying deliveryId/);
});

await check("RED 2b — a fire with no reply.post row fails the choke-point gate, and not an earlier one", async () => {
  const result = await smoke({ reply: false });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "audits OUR delivery").pass, true);
  assert.equal(gate(result, "FIRED rather than being declined").pass, true);
  assert.equal(gate(result, "reply choke point").pass, false);
  assert.match(gate(result, "reply choke point").detail, /no reply\.post row for surface/);
});

await check("RED 2c — a reply on a DIFFERENT surface does not satisfy the choke-point gate", async () => {
  const result = await smoke({ replySurface: "C_SOME_OTHER_CHANNEL" });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "reply choke point").pass, false);
});

await check("a delivery that reaches the hook but is DECLINED reds with the reason, not as a missing row", async () => {
  const result = await smoke({ fire: "declined", reply: false });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "audits OUR delivery").pass, true, "a declined delivery WAS audited — the join gate must not red on it");
  assert.equal(gate(result, "FIRED rather than being declined").pass, false);
  assert.match(gate(result, "FIRED rather than being declined").detail, /webhook\.declined.*over the spend cap/s);
});

await check("RED 3a — an unsigned delivery the ingress ACCEPTS fails the refusal gate", async () => {
  const result = await smoke({ unsignedStatus: 200 });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "unsigned webhook POST is refused").pass, false);
  assert.match(gate(result, "unsigned webhook POST is refused").detail, /-> 200/);
});

await check("RED 3b — a 401 with a fire BEHIND it still reds, on the no-trace gate", async () => {
  const result = await smoke({ fireUnsigned: true });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "unsigned webhook POST is refused").pass, true, "the status was a correct 401 — the red comes from the ROW");
  assert.equal(gate(result, "leaves NO audit trace").pass, false);
  assert.match(gate(result, "leaves NO audit trace").detail, /carry the REFUSED delivery id/);
});

await check("a fire row from ANOTHER delivery, in the same window, does NOT satisfy the join gate", async () => {
  const decoys = [
    row("webhook.fired", { detail: { hookId: HOOK, deliveryId: "e2e-someone-elses-delivery" } }),
    row("webhook.fired", { detail: { hookId: HOOK } }),
    row("reply.post", { detail: { route: "terminal", chars: 9 } }),
  ];
  const result = await smoke({ fire: "none", reply: false, decoys });
  assert.equal(result.ok, false, "a window full of other traffic must not fake a green");
  assert.equal(gate(result, "audits OUR delivery").pass, false);
});

await check("a decoy row cannot fake the no-trace gate either — the join is on OUR refused id", async () => {
  const decoys = [row("webhook.fired", { detail: { hookId: HOOK, deliveryId: "e2e-someone-elses-delivery" } })];
  const result = await smoke({ decoys });
  assert.equal(gate(result, "leaves NO audit trace").pass, true, "another sender's fire is not our refused delivery's trace");
});

await check("an unreadable audit route THROWS rather than reporting a green or a silent empty result", async () => {
  await assert.rejects(() => smoke({ auditStatus: 401 }), /control\/v1\/audit -> 401/);
});

await check("rowDeliveryId reads a string id and refuses a non-string one", () => {
  assert.equal(rowDeliveryId(row("webhook.fired", { detail: { deliveryId: "abc" } })), "abc");
  assert.equal(rowDeliveryId(row("webhook.fired", { detail: { deliveryId: 7 } })), undefined);
  assert.equal(rowDeliveryId(row("webhook.fired")), undefined);
});

await check("renderSmokeReport names the rollback checklist on a red and never on a green", async () => {
  const green = renderSmokeReport(await smoke()).join("\n");
  assert.match(green, /✓ deploy:smoke: 6 deterministic gate\(s\) passed — no judge involved/);
  assert.doesNotMatch(green, /rollback/);
  const red = renderSmokeReport(await smoke({ fire: "none", reply: false })).join("\n");
  assert.match(red, /deterministic gate\(s\) FAILED/);
  assert.match(red, /docs\/deploy\/rollback\.md/);
});

await check("WebhookDriver still sends NO headers when unsigned with no deliveryId (S20's negative leg is unchanged)", async () => {
  let seen: Record<string, string> | undefined;
  const driver = new WebhookDriver({ targetUrl: TARGET, secret: "whsec_c2VjcmV0", hookId: HOOK }, async (_url, init) => {
    seen = init.headers;
    return { status: 401, text: async () => "" };
  });
  await driver.post({ note: "x" }, { signed: false });
  assert.deepEqual(Object.keys(seen ?? {}), ["content-type"], "an unsigned POST with no deliveryId carries only content-type");
});

if (failures.length > 0) {
  console.error(`✗ deploy-smoke: ${failures.length} of ${checks} check(s) FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ deploy-smoke: ${checks} check(s) passed (gate ladder, three reds, the exact delivery-id join — all offline)`);
