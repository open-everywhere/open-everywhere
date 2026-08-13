import { buildAuditQuery, type AuditWireEntry } from "../../packages/core/scripts/e2e/audit-read.js";
import { WebhookDriver, webhookDeliveryId, type WebhookFetch } from "../../packages/core/scripts/e2e/webhook.js";
import type { WebhookConfig } from "../../packages/core/scripts/e2e/env.js";

const FIRE_ACTIONS = ["webhook.fired", "webhook.declined"] as const;

export interface SmokeGate {
  readonly label: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly gates: readonly SmokeGate[];
}

export interface SmokeDeps {
  readonly webhook: WebhookConfig;
  readonly controlToken: string;
  readonly fetchImpl: WebhookFetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly firedTimeoutMs?: number;
  readonly replyTimeoutMs?: number;
  readonly unsignedGraceMs?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULTS = { firedTimeoutMs: 60_000, replyTimeoutMs: 240_000, unsignedGraceMs: 15_000, pollIntervalMs: 2_000 };

async function readAudit(deps: SmokeDeps, sinceIso: string, actions: readonly string[]): Promise<readonly AuditWireEntry[]> {
  const base = deps.webhook.targetUrl.replace(/\/+$/, "");
  const query = buildAuditQuery({ sinceIso, actions, limit: 100 });
  const res = await deps.fetchImpl(`${base}/control/v1/audit?${query}`, {
    method: "GET",
    headers: { authorization: `Bearer ${deps.controlToken}`, accept: "application/json" },
    body: "",
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`GET /control/v1/audit -> ${res.status} (${text.slice(0, 160)})`);
  const parsed = JSON.parse(text) as { entries?: AuditWireEntry[] };
  if (!Array.isArray(parsed.entries)) throw new Error("GET /control/v1/audit returned no entries array (malformed response)");
  return parsed.entries;
}

async function pollForRow(
  deps: SmokeDeps,
  sinceIso: string,
  actions: readonly string[],
  find: (rows: readonly AuditWireEntry[]) => AuditWireEntry | undefined,
  timeoutMs: number,
): Promise<AuditWireEntry | undefined> {
  const interval = deps.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const hit = find(await readAudit(deps, sinceIso, actions));
    if (hit) return hit;
    if (deps.now() >= deadline) return undefined;
    await deps.sleep(interval);
  }
}

function detailString(row: AuditWireEntry, key: string): string | undefined {
  const v = row.detail?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function rowDeliveryId(row: AuditWireEntry): string | undefined {
  return detailString(row, "deliveryId");
}

export function rowWakeId(row: AuditWireEntry): string | undefined {
  return detailString(row, "wakeId");
}

export async function runWebhookSmoke(deps: SmokeDeps): Promise<SmokeResult> {
  const firedTimeoutMs = deps.firedTimeoutMs ?? DEFAULTS.firedTimeoutMs;
  const replyTimeoutMs = deps.replyTimeoutMs ?? DEFAULTS.replyTimeoutMs;
  const unsignedGraceMs = deps.unsignedGraceMs ?? DEFAULTS.unsignedGraceMs;
  const driver = new WebhookDriver(deps.webhook, deps.fetchImpl);
  const gates: SmokeGate[] = [];
  const gate = (label: string, pass: boolean, detail: string): boolean => {
    gates.push({ label, pass, detail });
    deps.log(`${pass ? "✓" : "✗"} ${label} — ${detail}`);
    return pass;
  };

  const signedId = webhookDeliveryId();
  const sinceIso = new Date(deps.now() - 30_000).toISOString();
  deps.log(`signed POST /webhooks/${deps.webhook.hookId} (delivery ${signedId})`);
  const signed = await driver.post(
    { note: `deploy-smoke ${signedId}`, source: "deploy:smoke" },
    { deliveryId: signedId },
  );
  let positiveOk = gate(
    "a signed webhook POST is accepted (200)",
    signed.status === 200,
    `POST /webhooks/${deps.webhook.hookId} -> ${signed.status}${signed.status === 200 ? "" : ` (${signed.body.slice(0, 160)})`}`,
  );

  let fired: AuditWireEntry | undefined;
  if (positiveOk) {
    fired = await pollForRow(
      deps,
      sinceIso,
      FIRE_ACTIONS,
      (rows) => rows.find((r) => rowDeliveryId(r) === signedId),
      firedTimeoutMs,
    );
    positiveOk = gate(
      "the deployment audits OUR delivery (a row carries the delivery id we minted)",
      fired !== undefined,
      fired
        ? `${fired.action} row at ${fired.ts}, hook ${String(fired.detail?.hookId)}, surface ${fired.surface ?? "-"}`
        : `no webhook.fired/webhook.declined row carrying deliveryId ${signedId} within ${firedTimeoutMs}ms`,
    );
  }

  if (positiveOk && fired) {
    positiveOk = gate(
      "that delivery FIRED rather than being declined",
      fired.action === "webhook.fired",
      fired.action === "webhook.fired" ? "action is webhook.fired" : `action is ${fired.action} (reason: ${String(fired.detail?.reason ?? "none recorded")})`,
    );
  }

  if (positiveOk && fired) {
    const surface = fired.surface;
    const firedTs = fired.ts;
    const fireWake = rowWakeId(fired);
    const reply = await pollForRow(
      deps,
      firedTs,
      ["reply.post"],
      (rows) => rows.find((r) => r.surface === surface && r.ts >= firedTs && (fireWake === undefined || rowWakeId(r) === fireWake)),
      replyTimeoutMs,
    );
    positiveOk = gate(
      fireWake === undefined
        ? "the fire reaches the reply choke point (a reply.post row lands on the hook's target surface — SURFACE+TIME window, not an exact join: this fire carried no wake id)"
        : "the fire reaches the reply choke point (a reply.post row carries THIS fire's wake id)",
      reply !== undefined,
      reply
        ? `reply.post at ${reply.ts}, route ${String(reply.detail?.route)}, ${String(reply.detail?.chars)} chars, session ${String(reply.detail?.sessionId)}` +
            (fireWake === undefined ? "" : `, wake ${fireWake}`)
        : fireWake === undefined
          ? `no reply.post row for surface ${surface ?? "-"} at/after ${firedTs} within ${replyTimeoutMs}ms`
          : `no reply.post row carrying wakeId ${fireWake} on surface ${surface ?? "-"} at/after ${firedTs} within ${replyTimeoutMs}ms`,
    );
  }

  const unsignedId = webhookDeliveryId();
  const unsignedSince = new Date(deps.now() - 30_000).toISOString();
  deps.log(`unsigned POST /webhooks/${deps.webhook.hookId} (delivery ${unsignedId})`);
  const unsigned = await driver.post({ note: `deploy-smoke unsigned ${unsignedId}` }, { signed: false, deliveryId: unsignedId });
  const refused = gate(
    "an unsigned webhook POST is refused (401)",
    unsigned.status === 401,
    `POST /webhooks/${deps.webhook.hookId} (no signature header) -> ${unsigned.status}`,
  );

  await deps.sleep(unsignedGraceMs);
  const strayRows = await readAudit(deps, unsignedSince, FIRE_ACTIONS);
  const stray = strayRows.filter((r) => rowDeliveryId(r) === unsignedId);
  const noTrace = gate(
    "the refused delivery leaves NO audit trace (nothing fired behind the 401)",
    stray.length === 0,
    stray.length === 0
      ? `no webhook.fired/webhook.declined row carries deliveryId ${unsignedId} after a ${unsignedGraceMs}ms grace window`
      : `${stray.length} row(s) carry the REFUSED delivery id: ${stray.map((r) => `${r.action}@${r.ts}`).join(", ")}`,
  );

  return { ok: positiveOk && refused && noTrace, gates };
}

export function renderSmokeReport(result: SmokeResult): readonly string[] {
  const lines = result.gates.map((g) => `  ${g.pass ? "✓" : "✗"} ${g.label}\n      ${g.detail}`);
  const reds = result.gates.filter((g) => !g.pass).length;
  lines.push(
    result.ok
      ? `✓ deploy:smoke: ${result.gates.length} deterministic gate(s) passed — no judge involved`
      : `✗ deploy:smoke: ${reds} of ${result.gates.length} deterministic gate(s) FAILED — run the rollback checklist (docs/deploy/rollback.md)`,
  );
  return lines;
}
