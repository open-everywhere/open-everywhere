import { createHmac, randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { auditCursor, bootAgent, rowsSinceCursor, setEnvForRunningAgent, sleep, waitFor } from "../harness";

const SECRET_BYTES = randomBytes(24);
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const ORG_DOMAIN = "it-email.example";
const INBOX = `room@agent.${ORG_DOMAIN}`;
const PERSONAL = `me@agent.${ORG_DOMAIN}`;

afterAll(async () => {
  const policy = await import("@open-everywhere/core/agent/email/policy.js");
  policy.resetEmailPolicyForTest();
});

function signedHeaders(body: string, id: string, opts: { readonly forge?: boolean } = {}): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = opts.forge === true ? randomBytes(24) : SECRET_BYTES;
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}

function delivery(from: string, nonce: string, inbox: string = INBOX): string {
  return JSON.stringify({
    type: "event",
    event_type: "message.received",
    event_id: `evt_${nonce}`,
    message: {
      inbox_id: inbox,
      thread_id: `thr_${nonce}`,
      message_id: `<msg-${nonce}@example>`,
      labels: [],
      timestamp: new Date().toISOString(),
      from,
      to: [inbox],
      subject: "Integration fixture",
      text: "Hello from the integration tier.",
      extracted_text: "Hello from the integration tier.",
      headers: { "Authentication-Results": `mx.agentmail.to; dmarc=pass header.from=${from.slice(from.lastIndexOf("@") + 1)}` },
    },
    thread: {},
  });
}

async function arm(): Promise<{ readonly base: string }> {
  const booted = await bootAgent();
  setEnvForRunningAgent("AGENTMAIL_WEBHOOK_SECRET", SECRET);
  const policy = await import("@open-everywhere/core/agent/email/policy.js");
  policy.registerEmailPolicy({
    enabled: true,
    transport: "agentmail",
    orgDomains: [ORG_DOMAIN],
    maxRecipients: 10,
    maxInboundChars: 20_000,
    inboxes: [
      { address: INBOX, kind: "room", allowedSenders: [`*@${ORG_DOMAIN}`], why: "integration fixture" },
      { address: PERSONAL, kind: "personal", allowedSenders: [], why: "integration fixture" },
    ],
  });
  return booted;
}

async function post(base: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/eve/v1/email`, { method: "POST", headers, body });
  return { status: res.status, body: await res.text() };
}

test("a forged email delivery is refused 401 and writes no email row; a signed stranger is refused not-allowed; an authenticated org sender to the personal inbox reaches the gate's last check", async () => {
  const { base } = await arm();
  const nonce = randomBytes(6).toString("hex");
  const cursor = await auditCursor();

  const forgedBody = delivery(`forger@${ORG_DOMAIN}`, `${nonce}-f`);
  const forged = await post(base, forgedBody, signedHeaders(forgedBody, `msg_${nonce}_f`, { forge: true }));
  expect(forged.status, forged.body).toBe(401);

  const strangerBody = delivery(`stranger-${nonce}@else.example`, `${nonce}-s`);
  const stranger = await post(base, strangerBody, signedHeaders(strangerBody, `msg_${nonce}_s`));
  expect(stranger.status, stranger.body).toBe(200);
  const refused = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["email.refused"]);
    return rows.find((r) => r.principalId === `stranger-${nonce}@else.example`);
  }, "the email.refused row for the stranger");
  expect(refused.detail?.reason).toBe("not-allowed");
  expect(refused.platform).toBe("email");

  const allowedBody = delivery(`ann-${nonce}@${ORG_DOMAIN}`, `${nonce}-a`, PERSONAL);
  const allowedHeaders = signedHeaders(allowedBody, `msg_${nonce}_a`);
  const allowed = await post(base, allowedBody, allowedHeaders);
  expect(allowed.status, allowed.body).toBe(200);
  const lastCheck = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["email.refused"]);
    return rows.find((r) => r.principalId === `ann-${nonce}@${ORG_DOMAIN}`);
  }, "the email.refused unknown-person row for the org sender");
  expect(lastCheck.detail?.reason).toBe("unknown-person");

  const retry = await post(base, allowedBody, allowedHeaders);
  expect(retry.status, retry.body).toBe(200);
  await sleep(2_000);
  const all = await rowsSinceCursor(cursor, ["email.refused", "email.admitted"]);
  expect(all.filter((r) => r.principalId === `ann-${nonce}@${ORG_DOMAIN}`)).toHaveLength(1);
  expect(all.find((r) => r.principalId === `forger@${ORG_DOMAIN}`)).toBeUndefined();
});
