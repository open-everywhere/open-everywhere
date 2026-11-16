import assert from "node:assert/strict";

import {
  GITHUB_INSTALLATION_SKIP,
  LINEAR_EXTERNAL_POLICY_SKIP,
  parseSkipOptOut,
  renderSkipSummary,
  resolveSkipOptOut,
  renderSmokeReport,
  runGithubInstallationSmoke,
  runLinearSignedDeliverySmoke,
  runWebhookSmoke,
  rowDeliveryId,
  rowWakeId,
  summariseSmokeRun,
  type SkippedRung,
  type SmokeResult,
} from "./deploy/smoke-lib.js";
import { WEBHOOK_ID_HEADER, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER, WebhookDriver } from "../packages/core/scripts/e2e/webhook.js";
import type { AuditWireEntry } from "../packages/core/scripts/e2e/audit-read.js";

import { tmpdir as __oeTmpdir } from "node:os";
import { join as __oeJoin } from "node:path";
import { rmSync as __oeRmSync } from "node:fs";
const __oeSuiteStoreDir = __oeJoin(__oeTmpdir(), `open-everywhere-suite-deploy-smoke-${process.pid}`);
__oeRmSync(__oeSuiteStoreDir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = __oeJoin(__oeSuiteStoreDir, "ops.sqlite3");

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
  readonly fireWakeId?: string | null;
  readonly replyWakeId?: string | null;
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

const WAKE = "wake-0f3a2b19";

function makeStub(opts: StubOpts = {}): Stub {
  const fireWake = opts.fireWakeId === undefined ? WAKE : opts.fireWakeId;
  const replyWake = opts.replyWakeId === undefined ? fireWake : opts.replyWakeId;
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
              detail: {
                hookId: HOOK,
                deliveryId,
                ...(opts.fire === "declined" ? { reason: "over the spend cap" } : {}),
                ...(fireWake === null ? {} : { wakeId: fireWake }),
              },
            }),
          );
        }
        if (opts.reply !== false) {
          rows.push(
            row("reply.post", {
              ...(opts.replySurface !== undefined ? { surface: opts.replySurface } : {}),
              detail: { route: "tool", chars: 42, sessionId: "sess-smoke", ...(replyWake === null ? {} : { wakeId: replyWake }) },
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
  assert.match(gate(result, "reply choke point").label, /carries THIS fire's wake id/);
  assert.match(gate(result, "reply choke point").detail, new RegExp(`wake ${WAKE}`));
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
  assert.match(gate(result, "reply choke point").detail, /no reply\.post row carrying wakeId/);
});

await check("RED 2c — a reply on a DIFFERENT surface does not satisfy the choke-point gate", async () => {
  const result = await smoke({ replySurface: "C_SOME_OTHER_CHANNEL" });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "reply choke point").pass, false);
});

await check("RED 2d — a reply on the right surface but from ANOTHER wake does NOT satisfy the gate", async () => {
  const result = await smoke({ replyWakeId: "wake-someone-elses-turn" });
  assert.equal(result.ok, false, "another turn's reply in the same channel must not fake a green");
  assert.equal(gate(result, "audits OUR delivery").pass, true, "the fire itself was ours — the red is the REPLY's join");
  assert.equal(gate(result, "reply choke point").pass, false);
  assert.match(gate(result, "reply choke point").detail, new RegExp(`no reply\\.post row carrying wakeId ${WAKE}`));
});

await check("RED 2e — a reply carrying NO wake id does not satisfy the exact join either", async () => {
  const result = await smoke({ replyWakeId: null });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "reply choke point").pass, false);
});

await check("the exact join survives a window FULL of other replies — it picks ours out", async () => {
  const decoys = [
    row("reply.post", { detail: { route: "tool", chars: 9, wakeId: "wake-another-turn" } }),
    row("reply.post", { detail: { route: "tool", chars: 3 } }),
  ];
  const result = await smoke({ decoys });
  assert.equal(result.ok, true, `expected ok; gates: ${JSON.stringify(result.gates)}`);
  assert.equal(gate(result, "reply choke point").pass, true);
  assert.match(gate(result, "reply choke point").detail, new RegExp(`wake ${WAKE}`));
});

await check("a NATIVE fire (no wake id on the fired row) degrades the gate and RENAMES it to say so", async () => {
  const result = await smoke({ fireWakeId: null, replyWakeId: null });
  assert.equal(result.ok, true, `expected ok; gates: ${JSON.stringify(result.gates)}`);
  const g = gate(result, "reply choke point");
  assert.equal(g.pass, true);
  assert.match(g.label, /SURFACE\+TIME window, not an exact join/);
  assert.doesNotMatch(g.label, /carries THIS fire's wake id/, "a degraded join must never wear the exact join's label");
  const other = await smoke({ fireWakeId: null, replyWakeId: null, replySurface: "C_SOME_OTHER_CHANNEL" });
  assert.equal(gate(other, "reply choke point").pass, false);
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
    row("reply.post", { detail: { route: "tool", chars: 9 } }),
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
  assert.equal(rowDeliveryId(row("webhook.fired", { detail: { deliveryId: "" } })), undefined, "a BLANK id is absent, never an id that matches another blank");
  assert.equal(rowDeliveryId(row("webhook.fired")), undefined);
});

await check("rowWakeId reads the reply join the same way, and refuses a blank or non-string one", () => {
  assert.equal(rowWakeId(row("reply.post", { detail: { wakeId: "w-1" } })), "w-1");
  assert.equal(rowWakeId(row("reply.post", { detail: { wakeId: 7 } })), undefined);
  assert.equal(rowWakeId(row("reply.post", { detail: { wakeId: "" } })), undefined);
  assert.equal(rowWakeId(row("reply.post")), undefined);
  assert.equal(rowWakeId(row("reply.post", { detail: { deliveryId: "d-1" } })), undefined, "the two joins never read each other's field");
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

const GH_SECRET = "it-gh-smoke-secret";

interface GithubStubOpts {
  readonly signedStatus?: number;
  readonly unsignedStatus?: number;
  readonly writeRow?: boolean;
  readonly writeRowForUnsigned?: boolean;
  readonly auditStatus?: number;
}

interface GithubStub {
  readonly fetchImpl: Parameters<typeof runGithubInstallationSmoke>[0]["fetchImpl"];
  readonly signedHeaders: Record<string, string>[];
  readonly unsignedHeaders: Record<string, string>[];
}

function makeGithubStub(opts: GithubStubOpts = {}): GithubStub {
  const rows: AuditWireEntry[] = [];
  const signedHeaders: Record<string, string>[] = [];
  const unsignedHeaders: Record<string, string>[] = [];
  const fetchImpl: GithubStub["fetchImpl"] = async (url, init) => {
    if (url.startsWith(`${TARGET}/eve/v1/github`)) {
      const headers = init.headers;
      const isSigned = headers["x-hub-signature-256"] !== undefined;
      const body = JSON.parse(init.body ?? "{}") as { installation?: { account?: { login?: string } } };
      const owner = body.installation?.account?.login;
      if (isSigned) {
        signedHeaders.push(headers);
        if ((opts.writeRow ?? true) && owner) rows.push({ ts: new Date().toISOString(), org: "default", platform: "github", workspace: owner, action: "surface.app_installed" });
        return { status: opts.signedStatus ?? 200, text: async () => "ok" };
      }
      unsignedHeaders.push(headers);
      if (opts.writeRowForUnsigned && owner) rows.push({ ts: new Date().toISOString(), org: "default", platform: "github", workspace: owner, action: "surface.app_installed" });
      return { status: opts.unsignedStatus ?? 401, text: async () => "unauthorized" };
    }
    if (url.startsWith(`${TARGET}/control/v1/audit`)) {
      const status = opts.auditStatus ?? 200;
      if (status !== 200) return { status, text: async () => "forbidden" };
      return { status: 200, text: async () => JSON.stringify({ entries: rows }) };
    }
    throw new Error(`github stub deployment got an unexpected request: ${url}`);
  };
  return { fetchImpl, signedHeaders, unsignedHeaders };
}

async function githubSmoke(opts: GithubStubOpts = {}, stub: GithubStub = makeGithubStub(opts)): Promise<SmokeResult> {
  let clock = Date.parse("2026-08-18T12:00:00.000Z");
  return runGithubInstallationSmoke({
    targetUrl: TARGET,
    webhookSecret: GH_SECRET,
    controlToken: "tok-read",
    fetchImpl: stub.fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => {},
    firedTimeoutMs: 10_000,
    unsignedGraceMs: 1_000,
    pollIntervalMs: 1_000,
  });
}

await check("a healthy deployment passes both github installation gates", async () => {
  const result = await githubSmoke();
  assert.equal(result.ok, true, `expected ok; gates: ${JSON.stringify(result.gates)}`);
  assert.equal(gate(result, "signed GitHub installation delivery is accepted").pass, true);
  assert.equal(gate(result, "audits OUR delivery").pass, true);
  assert.equal(gate(result, "unsigned GitHub installation delivery is refused").pass, true);
  assert.equal(gate(result, "leaves NO audit trace").pass, true);
  assert.equal(result.gates.length, 4);
});

await check("the signed POST carries x-hub-signature-256; the unsigned one carries none", async () => {
  const stub = makeGithubStub();
  await githubSmoke({}, stub);
  assert.ok(stub.signedHeaders[0]?.["x-hub-signature-256"], "signed delivery carries x-hub-signature-256");
  assert.match(stub.signedHeaders[0]!["x-hub-signature-256"]!, /^sha256=[0-9a-f]{64}$/);
  assert.equal(stub.unsignedHeaders[0]?.["x-hub-signature-256"], undefined, "the unsigned delivery carries no signature header");
});

await check("RED — no 200 on the signed leg fails the FIRST gate and stops there (no false audit-row gate)", async () => {
  const result = await githubSmoke({ signedStatus: 500 });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "signed GitHub installation delivery is accepted").pass, false);
  assert.ok(!result.gates.some((g) => g.label.includes("audits OUR delivery")), "the audit-row gate must not even be ATTEMPTED once the 200 gate is red");
});

await check("RED — 200 with no surface.app_installed row fails the audit-row gate", async () => {
  const result = await githubSmoke({ writeRow: false });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "signed GitHub installation delivery is accepted").pass, true, "the 200 gate itself is still green");
  assert.equal(gate(result, "audits OUR delivery").pass, false);
});

await check("RED — an unsigned delivery accepted (200) AND leaving a row behind fails BOTH negative gates", async () => {
  const result = await githubSmoke({ unsignedStatus: 200, writeRowForUnsigned: true });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "unsigned GitHub installation delivery is refused").pass, false);
  assert.equal(gate(result, "leaves NO audit trace").pass, false);
});

await check("RED — a 401 with a row behind it (the worst outcome) is still caught: the status-only gate would have missed it", async () => {
  const result = await githubSmoke({ writeRowForUnsigned: true });
  assert.equal(gate(result, "unsigned GitHub installation delivery is refused").pass, true, "the status code alone looks fine");
  assert.equal(gate(result, "leaves NO audit trace").pass, false, "…but the trace gate catches what the status code could not");
  assert.equal(result.ok, false);
});

await check("a surface.app_installed row for a DIFFERENT owner does not satisfy the join", async () => {
  const stub = makeGithubStub({ writeRow: false });
  const decoyFetch: typeof stub.fetchImpl = async (url, init) => {
    if (url.startsWith(`${TARGET}/control/v1/audit`)) {
      return { status: 200, text: async () => JSON.stringify({ entries: [{ ts: new Date().toISOString(), org: "default", platform: "github", workspace: "some-other-owner", action: "surface.app_installed" }] }) };
    }
    return stub.fetchImpl(url, init);
  };
  const result = await githubSmoke({}, { ...stub, fetchImpl: decoyFetch });
  assert.equal(gate(result, "audits OUR delivery").pass, false, "a decoy owner's row must not satisfy the join");
});

const LINEAR_SECRET = "it-linear-smoke-secret";
const LINEAR_SMOKE_SURFACE = (teamId: string): string => `linear/oe-deploy-smoke-linear-org/${teamId}`;

interface LinearStubOpts {
  readonly signedStatus?: number;
  readonly unsignedStatus?: number;
  readonly writeRow?: boolean;
  readonly rowVerdict?: string;
  readonly writeRowForUnsigned?: boolean;
  readonly auditStatus?: number;
  readonly decoys?: readonly AuditWireEntry[];
}

interface LinearStub {
  readonly fetchImpl: Parameters<typeof runLinearSignedDeliverySmoke>[0]["fetchImpl"];
  readonly signedHeaders: Record<string, string>[];
  readonly unsignedHeaders: Record<string, string>[];
}

function teamIdFromForgedBody(rawBody: string | undefined): string | undefined {
  const body = JSON.parse(rawBody ?? "{}") as { agentSession?: { issue?: { team?: { id?: string } } } };
  return body.agentSession?.issue?.team?.id;
}

function makeLinearStub(opts: LinearStubOpts = {}): LinearStub {
  const rows: AuditWireEntry[] = [...(opts.decoys ?? [])];
  const signedHeaders: Record<string, string>[] = [];
  const unsignedHeaders: Record<string, string>[] = [];
  const fetchImpl: LinearStub["fetchImpl"] = async (url, init) => {
    if (url.startsWith(`${TARGET}/eve/v1/linear`)) {
      const headers = init.headers;
      const isSigned = headers["linear-signature"] !== undefined;
      const teamId = teamIdFromForgedBody(init.body);
      if (isSigned) {
        signedHeaders.push(headers);
        if ((opts.writeRow ?? true) && teamId) {
          rows.push({
            ts: new Date().toISOString(),
            org: "default",
            platform: "linear",
            workspace: "oe-deploy-smoke-linear-org",
            surface: LINEAR_SMOKE_SURFACE(teamId),
            action: "linear.external_policy_suppressed",
            detail: { verdict: opts.rowVerdict ?? "silent-room" },
          });
        }
        return { status: opts.signedStatus ?? 200, text: async () => "ok" };
      }
      unsignedHeaders.push(headers);
      if (opts.writeRowForUnsigned && teamId) {
        rows.push({
          ts: new Date().toISOString(),
          org: "default",
          platform: "linear",
          workspace: "oe-deploy-smoke-linear-org",
          surface: LINEAR_SMOKE_SURFACE(teamId),
          action: "linear.external_policy_suppressed",
          detail: { verdict: "silent-room" },
        });
      }
      return { status: opts.unsignedStatus ?? 401, text: async () => "unauthorized" };
    }
    if (url.startsWith(`${TARGET}/control/v1/audit`)) {
      const status = opts.auditStatus ?? 200;
      if (status !== 200) return { status, text: async () => "forbidden" };
      return { status: 200, text: async () => JSON.stringify({ entries: rows }) };
    }
    throw new Error(`linear stub deployment got an unexpected request: ${url}`);
  };
  return { fetchImpl, signedHeaders, unsignedHeaders };
}

async function linearSmoke(opts: LinearStubOpts = {}, stub: LinearStub = makeLinearStub(opts)): Promise<SmokeResult> {
  let clock = Date.parse("2026-08-19T12:00:00.000Z");
  return runLinearSignedDeliverySmoke({
    targetUrl: TARGET,
    webhookSecret: LINEAR_SECRET,
    controlToken: "tok-read",
    fetchImpl: stub.fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => {},
    firedTimeoutMs: 10_000,
    unsignedGraceMs: 1_000,
    pollIntervalMs: 1_000,
  });
}

await check("a healthy deployment passes every linear room-grain gate", async () => {
  const result = await linearSmoke();
  assert.equal(result.ok, true, `expected ok; gates: ${JSON.stringify(result.gates)}`);
  assert.equal(gate(result, "signed Linear agent-session delivery is accepted").pass, true);
  assert.equal(gate(result, "audits OUR delivery").pass, true);
  assert.equal(gate(result, "the ROOM grain (verdict silent-room)").pass, true);
  assert.equal(gate(result, "unsigned Linear agent-session delivery is refused").pass, true);
  assert.equal(gate(result, "leaves NO audit trace").pass, true);
  assert.equal(result.gates.length, 5);
});

await check("the signed POST carries linear-signature; the unsigned one carries none", async () => {
  const stub = makeLinearStub();
  await linearSmoke({}, stub);
  assert.ok(stub.signedHeaders[0]?.["linear-signature"], "signed delivery carries linear-signature");
  assert.equal(stub.unsignedHeaders[0]?.["linear-signature"], undefined, "the unsigned delivery carries no signature header");
});

await check("RED — no 200 on the signed leg fails the FIRST gate and stops there (no false audit-row gate)", async () => {
  const result = await linearSmoke({ signedStatus: 500 });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "signed Linear agent-session delivery is accepted").pass, false);
  assert.ok(!result.gates.some((g) => g.label.includes("audits OUR delivery")), "the audit-row gate must not even be ATTEMPTED once the 200 gate is red");
});

await check("RED — 200 with no linear.external_policy_suppressed row fails the audit-row gate", async () => {
  const result = await linearSmoke({ writeRow: false });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "signed Linear agent-session delivery is accepted").pass, true, "the 200 gate itself is still green");
  assert.equal(gate(result, "audits OUR delivery").pass, false);
  assert.ok(!result.gates.some((g) => g.label.includes("silent-room")), "the verdict gate must not even be attempted once the row gate is red");
});

await check("RED — a row on our surface with the WRONG verdict fails the room-grain gate, not the join gate", async () => {
  const result = await linearSmoke({ rowVerdict: "withheld-author" });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "audits OUR delivery").pass, true, "the join itself was ours — the red is the VERDICT");
  assert.equal(gate(result, "the ROOM grain (verdict silent-room)").pass, false);
  assert.match(gate(result, "the ROOM grain (verdict silent-room)").detail, /verdict is withheld-author/);
});

await check("RED — an unsigned delivery accepted (200) AND leaving a row behind fails BOTH negative gates", async () => {
  const result = await linearSmoke({ unsignedStatus: 200, writeRowForUnsigned: true });
  assert.equal(result.ok, false);
  assert.equal(gate(result, "unsigned Linear agent-session delivery is refused").pass, false);
  assert.equal(gate(result, "leaves NO audit trace").pass, false);
});

await check("RED — a 401 with a row behind it (the worst outcome) is still caught: the status-only gate would have missed it", async () => {
  const result = await linearSmoke({ writeRowForUnsigned: true });
  assert.equal(gate(result, "unsigned Linear agent-session delivery is refused").pass, true, "the status code alone looks fine");
  assert.equal(gate(result, "leaves NO audit trace").pass, false, "…but the trace gate catches what the status code could not");
  assert.equal(result.ok, false);
});

await check("a linear.external_policy_suppressed row for a DIFFERENT team (a stray from another run) does not satisfy the join", async () => {
  const stub = makeLinearStub({ writeRow: false });
  const decoyFetch: typeof stub.fetchImpl = async (url, init) => {
    if (url.startsWith(`${TARGET}/control/v1/audit`)) {
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            entries: [
              {
                ts: new Date().toISOString(),
                org: "default",
                platform: "linear",
                workspace: "oe-deploy-smoke-linear-org",
                surface: LINEAR_SMOKE_SURFACE("oe-deploy-smoke-some-other-run"),
                action: "linear.external_policy_suppressed",
                detail: { verdict: "silent-room" },
              },
            ],
          }),
      };
    }
    return stub.fetchImpl(url, init);
  };
  const result = await linearSmoke({}, { ...stub, fetchImpl: decoyFetch });
  assert.equal(gate(result, "audits OUR delivery").pass, false, "a decoy run's row must not satisfy the join");
});

await check("a decoy row cannot fake the no-trace gate either — the join is on OUR refused surface", async () => {
  const decoys: AuditWireEntry[] = [
    {
      ts: new Date().toISOString(),
      org: "default",
      platform: "linear",
      workspace: "oe-deploy-smoke-linear-org",
      surface: LINEAR_SMOKE_SURFACE("oe-deploy-smoke-some-other-run"),
      action: "linear.external_policy_suppressed",
      detail: { verdict: "silent-room" },
    },
  ];
  const result = await linearSmoke({ decoys });
  assert.equal(gate(result, "leaves NO audit trace").pass, true, "another run's row is not our refused delivery's trace");
});

await check("an unreadable audit route THROWS rather than reporting a green or a silent empty result (linear rung)", async () => {
  await assert.rejects(() => linearSmoke({ auditStatus: 401 }), /control\/v1\/audit -> 401/);
});

const GITHUB_SKIP: SkippedRung = GITHUB_INSTALLATION_SKIP;
const LINEAR_SKIP: SkippedRung = LINEAR_EXTERNAL_POLICY_SKIP;

await check("🔴 the CLASSIFICATION itself is pinned: github is a launch surface, linear is not", () => {
  assert.equal(GITHUB_INSTALLATION_SKIP.launchSurface, true, "the github installation rung is a LAUNCH-SURFACE security rung — flipping this is how the gate stops biting");
  assert.equal(GITHUB_INSTALLATION_SKIP.rung, "github", "…and its opt-out name is the word an operator passes to --allow-skip");
  assert.equal(LINEAR_EXTERNAL_POLICY_SKIP.launchSurface, false, "the linear rung is NOT a launch surface, so it reports and never gates (the OPE-783 posture)");
  assert.equal(LINEAR_EXTERNAL_POLICY_SKIP.rung, "linear", "…under its own opt-out name");
  for (const e of [GITHUB_INSTALLATION_SKIP, LINEAR_EXTERNAL_POLICY_SKIP]) {
    assert.ok(e.reason.length > 0 && e.label.length > 0, "every ledger entry states a reason and a label — the summary prints both");
    assert.doesNotMatch(e.reason, /=/u, "a reason names the missing INPUT, never a secret value");
  }
});

await check("🔴 a skipped LAUNCH-SURFACE rung with NO opt-out exits NON-ZERO, even with every gate that ran green", () => {
  const summary = summariseSmokeRun(true, [GITHUB_SKIP], parseSkipOptOut(undefined));
  assert.equal(summary.gatesOk, true, "every gate that RAN passed — the ledger is the only reason for the red");
  assert.equal(summary.exitCode, 1, "a launch-surface security rung nobody waived reds the ship");
  assert.deepEqual(summary.unproven, [GITHUB_SKIP], "and the rung is named as unproven, not merely counted");
  assert.deepEqual(summary.optedOut, [], "nothing was waived");
  const text = renderSkipSummary(summary).join("\n");
  assert.match(text, /SKIPPED \(no E2E_GITHUB_WEBHOOK_SECRET/u, "the summary states the skip in the SKIPPED (reason) vocabulary");
  assert.match(text, /did not earn its green/u, "and says why the run is red");
});

await check("the SAME skip with an opt-out naming that rung exits 0, and the waiver is printed", () => {
  const summary = summariseSmokeRun(true, [GITHUB_SKIP], parseSkipOptOut("github"));
  assert.equal(summary.exitCode, 0, "an explicitly waived launch-surface skip does not red the ship");
  assert.deepEqual(summary.optedOut, [GITHUB_SKIP], "the waiver is recorded against the rung");
  assert.deepEqual(summary.unproven, [], "so nothing is unproven-and-unwaived");
  const text = renderSkipSummary(summary).join("\n");
  assert.match(text, /SKIPPED \(no E2E_GITHUB_WEBHOOK_SECRET/u, "the skip is STILL reported — a waiver is not a silence");
  assert.match(text, /waived by an explicit opt-out naming "github"/u, "and the waiver itself is printed, so a ship record carries it");
  assert.doesNotMatch(text, /did not earn its green/u, "no red verdict on a waived run");
});

await check("an opt-out naming a DIFFERENT rung waives nothing", () => {
  const summary = summariseSmokeRun(true, [GITHUB_SKIP], parseSkipOptOut("linear,slack"));
  assert.equal(summary.exitCode, 1, "waiving some other rung is not waiving this one");
  assert.deepEqual(summary.unproven, [GITHUB_SKIP], "the github rung is still unproven");
});

await check("the LINEAR rung stays OPT-IN: its skip is reported and does NOT gate (OPE-783 posture kept)", () => {
  const summary = summariseSmokeRun(true, [LINEAR_SKIP], parseSkipOptOut(undefined));
  assert.equal(summary.exitCode, 0, "Linear is not a launch surface, so an absent secret must not red a ship");
  assert.deepEqual(summary.unproven, [], "it is not a launch-surface rung, so it can never be unproven-and-gating");
  const text = renderSkipSummary(summary).join("\n");
  assert.match(text, /SKIPPED \(no E2E_LINEAR_WEBHOOK_SECRET/u, "🔴 but the skip IS in the summary — the reporting half applies to every rung");
  assert.match(text, /not a launch surface — reported, not gated/u, "and the summary says which posture it is under");
});

await check("both rungs skipped, only the launch one waived ⇒ exit 0 and BOTH skips reported", () => {
  const summary = summariseSmokeRun(true, [GITHUB_SKIP, LINEAR_SKIP], parseSkipOptOut("github"));
  assert.equal(summary.exitCode, 0, "the waived launch rung and the opt-in rung both clear");
  assert.equal(summary.skipped.length, 2, "the ledger keeps both, in ladder order");
  const text = renderSkipSummary(summary).join("\n");
  assert.match(text, /GITHUB_WEBHOOK_SECRET/u, "the github skip is reported");
  assert.match(text, /LINEAR_WEBHOOK_SECRET/u, "the linear skip is reported");
});

await check("a REAL gate failure still reds the run, and an opt-out cannot waive it", () => {
  const summary = summariseSmokeRun(false, [GITHUB_SKIP], parseSkipOptOut("github"));
  assert.equal(summary.exitCode, 1, "🔴 --allow-skip waives a MISSING proof, never a FAILED one");
  assert.equal(summary.gatesOk, false, "the gate verdict is carried through untouched");
});

await check("a clean run reports zero skips rather than printing nothing", () => {
  const summary = summariseSmokeRun(true, [], parseSkipOptOut(undefined));
  assert.equal(summary.exitCode, 0, "nothing skipped, every gate green");
  const text = renderSkipSummary(summary).join("\n");
  assert.match(text, /0 rung\(s\) skipped — every rung in the ladder ran/u, "the block always prints: its absence is what let a partial run read as finished");
});

await check("🔴 the flag/env PRECEDENCE the docs state, driven — not restated", () => {
  const flagWins = resolveSkipOptOut("linear", "github");
  assert.equal(flagWins.has("linear"), true, "a --allow-skip WITH a value decides");
  assert.equal(flagWins.has("github"), false, "🔴 …and the env value is NOT merged in — one source decides, so a command line means what it says");
  const envDecides = resolveSkipOptOut(undefined, "github");
  assert.equal(envDecides.has("github"), true, "a VALUELESS --allow-skip is absent from parseArgs' `values`, so it defers to OE_SMOKE_ALLOW_SKIP");
  assert.equal(resolveSkipOptOut(undefined, undefined).size, 0, "neither source set waives nothing");
  assert.equal(resolveSkipOptOut("", "github").has("github"), false, "🔴 an EMPTY --allow-skip= is a value, so it decides — and it names no rung, so it waives none");
});

await check("parseSkipOptOut: a valueless or empty opt-out is NOT a blanket waiver", () => {
  assert.equal(parseSkipOptOut(undefined).size, 0, "absent waives nothing");
  assert.equal(parseSkipOptOut("").size, 0, "empty waives nothing");
  assert.equal(parseSkipOptOut("   ").size, 0, "whitespace waives nothing");
  assert.equal(parseSkipOptOut(",,").size, 0, "bare separators waive nothing");
  const many = parseSkipOptOut(" GitHub , linear ");
  assert.equal(many.has("github") && many.has("linear"), true, "a comma list is trimmed and case-folded");
  assert.equal(many.size, 2, "and holds exactly the rungs it named");
});

if (failures.length > 0) {
  console.error(`✗ deploy-smoke: ${failures.length} of ${checks} check(s) FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  `✓ deploy-smoke: ${checks} check(s) passed (gate ladder, three reds, the exact delivery-id join, the github installation rung, the linear room-grain rung, the OPE-2154 skip ledger — all offline)`,
);
