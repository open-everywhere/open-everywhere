import { createHmac, timingSafeEqual } from "node:crypto";
import {
  emailDomainOf,
  getOperatorSecret,
  normalizeEmailAddress,
  parseMailbox,
  withRetryAfter,
  type EmailDeliveryVerdict,
  type EmailReplyRequest,
  type EmailReplyResult,
  type EmailThreadMessage,
  type EmailTransport,
  type InboundEmail,
} from "@open-everywhere/core/agent/adapter-api.js";

export const AGENTMAIL_API_KEY_SECRET = "AGENTMAIL_API_KEY";
export const AGENTMAIL_WEBHOOK_SECRET = "AGENTMAIL_WEBHOOK_SECRET";

const AGENTMAIL_SHARED_DOMAINS: readonly string[] = ["agentmail.to"];

export const AGENTMAIL_API_HOSTS = { us: "https://api.agentmail.to", eu: "https://api.agentmail.eu" } as const;

const TIMESTAMP_TOLERANCE_S = 300;

const REQUEST_TIMEOUT_MS = 20_000;

const LOOP_GUARD_HEADERS = ["auto-submitted", "precedence", "list-id", "list-unsubscribe", "x-autoreply", "x-autorespond", "x-auto-response-suppress"] as const;

export interface AgentMailDeps {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly secret?: (name: string) => Promise<string | undefined>;
}

async function liveSecret(name: string): Promise<string | undefined> {
  try {
    return (await getOperatorSecret(name)).value;
  } catch {
    return undefined;
  }
}

export function verifySvixSignature(input: {
  readonly secret: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  readonly nowMs: number;
}): EmailDeliveryVerdict {
  const { secret, headers } = input;
  if (!secret) return { ok: false, reason: "no webhook secret is configured" };
  const id = headers["svix-id"];
  const ts = headers["svix-timestamp"];
  const sigs = headers["svix-signature"];
  if (!id || !ts || !sigs) return { ok: false, reason: "missing svix-id, svix-timestamp or svix-signature" };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: "svix-timestamp is not a unix time" };
  if (Math.abs(input.nowMs / 1000 - Number(ts)) > TIMESTAMP_TOLERANCE_S) return { ok: false, reason: "svix-timestamp is outside the five-minute window" };
  const keyB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyB64, "base64");
  } catch {
    return { ok: false, reason: "the webhook secret is not base64" };
  }
  if (key.length === 0) return { ok: false, reason: "the webhook secret is empty" };
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${input.rawBody}`).digest();
  for (const part of sigs.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    let given: Buffer;
    try {
      given = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "no svix-signature matched" };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strList(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const RECEIVED_EVENTS: Readonly<Record<string, { readonly candidate: boolean; readonly flagged?: "spam" | "blocked" }>> = {
  "message.received": { candidate: true },
  "message.received.unauthenticated": { candidate: false },
  "message.received.spam": { candidate: false, flagged: "spam" },
  "message.received.blocked": { candidate: false, flagged: "blocked" },
};

function authResultsValues(rawHeaders: Readonly<Record<string, unknown>>): readonly string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (k.toLowerCase() !== "authentication-results") continue;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
  }
  return out;
}

function stripComments(v: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === "\\" && depth > 0) {
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

export function agentMailSenderAuth(candidate: boolean, authResults: readonly string[], from: string): InboundEmail["senderAuth"] {
  const values = authResults.map((v) => stripComments(v).toLowerCase());
  const dmarcOf = (v: string): readonly string[] =>
    v
      .split(";")
      .map((r) => r.trim())
      .filter((r) => /^dmarc\s*=/.test(r));
  if (values.some((v) => dmarcOf(v).some((r) => /^dmarc\s*=\s*(fail|permerror|temperror)\b/.test(r)))) return "fail";
  if (!candidate) return "none";
  const first = values[0];
  if (first === undefined) return "none";
  const results = dmarcOf(first);
  if (results.length !== 1 || !/^dmarc\s*=\s*pass(\s|$)/.test(results[0]!)) return "none";
  const fromDomain = emailDomainOf(parseMailbox(from)?.address ?? "");
  if (fromDomain === "") return "none";
  const named = /(?:^|\s)header\.from\s*=\s*"?([a-z0-9.-]+)"?/.exec(results[0]!)?.[1];
  return named === fromDomain ? "pass" : "none";
}

export function parseAgentMailDelivery(headers: Readonly<Record<string, string>>, rawBody: string): InboundEmail | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const cls = typeof b.event_type === "string" ? RECEIVED_EVENTS[b.event_type] : undefined;
  if (!cls) return null;
  const m = b.message as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object") return null;
  const inbox = normalizeEmailAddress(String(m.inbox_id ?? ""));
  const messageId = str(m.message_id);
  const threadId = str(m.thread_id);
  const from = str(m.from);
  const deliveryId = headers["svix-id"] ?? str(b.event_id);
  if (!inbox || !messageId || !threadId || !from || !deliveryId) return null;
  const rawHeaders = m.headers && typeof m.headers === "object" ? (m.headers as Record<string, unknown>) : {};
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) if (typeof v === "string") lower[k.toLowerCase()] = v;
  const loopHeaders: Record<string, string> = {};
  for (const k of LOOP_GUARD_HEADERS) if (lower[k] !== undefined) loopHeaders[k] = lower[k]!.slice(0, 500);
  const senderAuth = agentMailSenderAuth(cls.candidate, authResultsValues(rawHeaders), from);
  const attachments = Array.isArray(m.attachments)
    ? (m.attachments as unknown[]).flatMap((a) => {
        if (!a || typeof a !== "object") return [];
        const r = a as Record<string, unknown>;
        return [{ ...(str(r.filename) ? { filename: str(r.filename)!.slice(0, 200) } : {}), ...(str(r.content_type) ? { contentType: str(r.content_type)! } : {}), size: typeof r.size === "number" ? r.size : 0 }];
      })
    : [];
  const fullText = str(m.text) ?? str(m.extracted_text) ?? str(m.preview) ?? "";
  const newText = str(m.extracted_text);
  return {
    deliveryId,
    inbox,
    messageId,
    threadId,
    from,
    replyTo: strList(m.reply_to),
    to: strList(m.to),
    cc: strList(m.cc),
    subject: str(m.subject) ?? "",
    ...(newText !== undefined ? { newText } : {}),
    fullText,
    receivedAt: str(m.timestamp) ?? str(m.created_at) ?? new Date().toISOString(),
    senderAuth,
    ...(cls.flagged ? { flagged: cls.flagged } : {}),
    headers: loopHeaders,
    attachments,
  };
}

export function agentMailTransport(id: string, apiBase: string, deps: AgentMailDeps = {}): EmailTransport {
  const doFetch = deps.fetch ?? fetch;
  const secret = deps.secret ?? liveSecret;
  const now = deps.now ?? Date.now;

  async function call(method: "GET" | "POST", path: string, operation: string, payload?: unknown): Promise<Record<string, unknown>> {
    const key = await secret(AGENTMAIL_API_KEY_SECRET);
    if (!key) throw new Error(`AgentMail ${operation} failed: no API key is configured (store it with \`oe secret set ${AGENTMAIL_API_KEY_SECRET}\`)`);
    const res = await withRetryAfter(
      () =>
        doFetch(`${apiBase}${path}`, {
          method,
          headers: { authorization: `Bearer ${key}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
          ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      { surface: "email", operation },
    );
    if (!res.ok) {
      throw new Error(`AgentMail ${operation} failed: HTTP ${res.status}`);
    }
    const json = (await res.json().catch(() => ({}))) as unknown;
    return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  }

  return {
    id,
    sharedDomains: AGENTMAIL_SHARED_DOMAINS,
    async verify(headers, rawBody) {
      return verifySvixSignature({ secret: await secret(AGENTMAIL_WEBHOOK_SECRET), headers, rawBody, nowMs: now() });
    },
    parse: parseAgentMailDelivery,
    async reply(req: EmailReplyRequest): Promise<EmailReplyResult> {
      if (req.to.length === 0) throw new Error("AgentMail reply refused: no recipient");
      const out = await call(
        "POST",
        `/v0/inboxes/${encodeURIComponent(req.inbox)}/messages/${encodeURIComponent(req.inReplyToMessageId)}/reply`,
        "reply",
        { to: [...req.to], ...(req.cc.length > 0 ? { cc: [...req.cc] } : {}), text: req.text },
      );
      const messageId = str(out.message_id);
      if (!messageId) throw new Error("AgentMail reply failed: the response carried no message id");
      return { messageId };
    },
    async readThread(inbox: string, threadId: string, limit: number): Promise<readonly EmailThreadMessage[]> {
      const out = await call("GET", `/v0/inboxes/${encodeURIComponent(inbox)}/threads/${encodeURIComponent(threadId)}`, "read-thread");
      const msgs = Array.isArray(out.messages) ? (out.messages as unknown[]) : [];
      const rows = msgs.flatMap((raw): EmailThreadMessage[] => {
        if (!raw || typeof raw !== "object") return [];
        const r = raw as Record<string, unknown>;
        const messageId = str(r.message_id);
        if (!messageId) return [];
        const labels = strList(r.labels).map((l) => l.toLowerCase());
        const sent = labels.includes("sent");
        const suspect = !sent && labels.some((l) => l === "unauthenticated" || l === "spam" || l === "blocked");
        return [
          {
            messageId,
            from: str(r.from) ?? "",
            to: strList(r.to),
            cc: strList(r.cc),
            sentAt: str(r.timestamp) ?? str(r.created_at) ?? "",
            text: str(r.extracted_text) ?? str(r.text) ?? str(r.preview) ?? "",
            ...(sent ? { sent: true } : {}),
            ...(suspect ? { suspect: true } : {}),
          },
        ];
      });
      return rows.sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0)).slice(-Math.max(1, limit));
    },
  };
}
