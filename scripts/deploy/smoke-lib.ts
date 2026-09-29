import { buildAuditQuery, type AuditWireEntry } from "../../packages/core/scripts/e2e/audit-read.js";
import { WebhookDriver, webhookDeliveryId, type WebhookFetch } from "../../packages/core/scripts/e2e/webhook.js";
import type { WebhookConfig } from "../../packages/core/scripts/e2e/env.js";
import { signGithubBody } from "../../packages/core/scripts/e2e/github-forge.js";
import { signLinearBody } from "../../packages/core/scripts/e2e/linear-driver.js";

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

export interface GithubInstallationSmokeDeps {
  readonly targetUrl: string;
  readonly webhookSecret: string;
  readonly controlToken: string;
  readonly fetchImpl: WebhookFetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly firedTimeoutMs?: number;
  readonly unsignedGraceMs?: number;
  readonly pollIntervalMs?: number;
}

function githubInstallationBody(action: string, owner: string, installationId: number): string {
  return JSON.stringify({ action, installation: { id: installationId, account: { login: owner, type: "Organization" } } });
}

async function readGithubAudit(deps: GithubInstallationSmokeDeps, sinceIso: string): Promise<readonly AuditWireEntry[]> {
  const base = deps.targetUrl.replace(/\/+$/, "");
  const query = buildAuditQuery({ sinceIso, actions: ["surface.app_installed"], limit: 100 });
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

export async function runGithubInstallationSmoke(deps: GithubInstallationSmokeDeps): Promise<SmokeResult> {
  const firedTimeoutMs = deps.firedTimeoutMs ?? DEFAULTS.firedTimeoutMs;
  const unsignedGraceMs = deps.unsignedGraceMs ?? DEFAULTS.unsignedGraceMs;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const base = deps.targetUrl.replace(/\/+$/, "");
  const gates: SmokeGate[] = [];
  const gate = (label: string, pass: boolean, detail: string): boolean => {
    gates.push({ label, pass, detail });
    deps.log(`${pass ? "✓" : "✗"} ${label} — ${detail}`);
    return pass;
  };

  const owner = `oe-deploy-smoke-${deps.now().toString(36)}`;
  const installationId = deps.now() % 1_000_000_000;
  const sinceIso = new Date(deps.now() - 30_000).toISOString();
  const body = githubInstallationBody("created", owner, installationId);
  deps.log(`signed POST /eve/v1/github (installation created, owner ${owner})`);
  const signed = await deps.fetchImpl(`${base}/eve/v1/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "installation", "x-hub-signature-256": signGithubBody(deps.webhookSecret, body) },
    body,
  });
  let positiveOk = gate(
    "a signed GitHub installation delivery is accepted (200)",
    signed.status === 200,
    `POST /eve/v1/github -> ${signed.status}`,
  );

  if (positiveOk) {
    const deadline = deps.now() + firedTimeoutMs;
    let found: AuditWireEntry | undefined;
    for (;;) {
      found = (await readGithubAudit(deps, sinceIso)).find((r) => r.workspace === owner);
      if (found || deps.now() >= deadline) break;
      await deps.sleep(pollIntervalMs);
    }
    positiveOk = gate(
      "the deployment audits OUR delivery (surface.app_installed carries our owner)",
      found !== undefined,
      found ? `${found.action} row at ${found.ts}` : `no surface.app_installed row carrying workspace ${owner} within ${firedTimeoutMs}ms`,
    );
  }

  const unsignedOwner = `oe-deploy-smoke-unsigned-${deps.now().toString(36)}`;
  const unsignedInstallationId = deps.now() % 1_000_000_000;
  const unsignedSince = new Date(deps.now() - 30_000).toISOString();
  const unsignedBody = githubInstallationBody("created", unsignedOwner, unsignedInstallationId);
  deps.log(`unsigned POST /eve/v1/github (installation created, owner ${unsignedOwner})`);
  const unsigned = await deps.fetchImpl(`${base}/eve/v1/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "installation" },
    body: unsignedBody,
  });
  const refused = gate("an unsigned GitHub installation delivery is refused (401)", unsigned.status === 401, `POST /eve/v1/github (no signature) -> ${unsigned.status}`);

  await deps.sleep(unsignedGraceMs);
  const strayRows = (await readGithubAudit(deps, unsignedSince)).filter((r) => r.workspace === unsignedOwner);
  const noTrace = gate(
    "the refused delivery leaves NO audit trace",
    strayRows.length === 0,
    strayRows.length === 0 ? `no surface.app_installed row carries workspace ${unsignedOwner}` : `${strayRows.length} row(s) carry the REFUSED owner`,
  );

  try {
    const cleanupBody = githubInstallationBody("deleted", owner, installationId);
    await deps.fetchImpl(`${base}/eve/v1/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "installation", "x-hub-signature-256": signGithubBody(deps.webhookSecret, cleanupBody) },
      body: cleanupBody,
    });
  } catch {
  }

  return { ok: positiveOk && refused && noTrace, gates };
}

export interface LinearSignedDeliverySmokeDeps {
  readonly targetUrl: string;
  readonly webhookSecret: string;
  readonly controlToken: string;
  readonly fetchImpl: WebhookFetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly firedTimeoutMs?: number;
  readonly unsignedGraceMs?: number;
  readonly pollIntervalMs?: number;
}

export { LINEAR_SMOKE_ORG, linearSmokeSurfaceKey, linearSmokeTeamId } from "./linear-smoke-keys.js";
import { LINEAR_SMOKE_ORG, linearSmokeSurfaceKey, linearSmokeTeamId } from "./linear-smoke-keys.js";

function linearSmokeAgentSessionBody(input: { readonly sessionId: string; readonly teamId: string; readonly issueId: string; readonly commentId: string; readonly nowMs: number }): string {
  return JSON.stringify({
    type: "AgentSessionEvent",
    action: "created",
    webhookTimestamp: input.nowMs,
    organizationId: LINEAR_SMOKE_ORG,
    agentSession: {
      id: input.sessionId,
      sourceCommentId: input.commentId,
      issue: { id: input.issueId, team: { id: input.teamId } },
    },
  });
}

async function readLinearAudit(deps: LinearSignedDeliverySmokeDeps, sinceIso: string): Promise<readonly AuditWireEntry[]> {
  const base = deps.targetUrl.replace(/\/+$/, "");
  const query = buildAuditQuery({ sinceIso, actions: ["linear.external_policy_suppressed"], limit: 100 });
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

export async function runLinearSignedDeliverySmoke(deps: LinearSignedDeliverySmokeDeps): Promise<SmokeResult> {
  const firedTimeoutMs = deps.firedTimeoutMs ?? DEFAULTS.firedTimeoutMs;
  const unsignedGraceMs = deps.unsignedGraceMs ?? DEFAULTS.unsignedGraceMs;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const base = deps.targetUrl.replace(/\/+$/, "");
  const gates: SmokeGate[] = [];
  const gate = (label: string, pass: boolean, detail: string): boolean => {
    gates.push({ label, pass, detail });
    deps.log(`${pass ? "✓" : "✗"} ${label} — ${detail}`);
    return pass;
  };

  const teamId = linearSmokeTeamId(deps.now());
  const surfaceKey = linearSmokeSurfaceKey(teamId);
  const sinceIso = new Date(deps.now() - 30_000).toISOString();
  const body = linearSmokeAgentSessionBody({
    sessionId: `oe-smoke-session-${teamId}`,
    teamId,
    issueId: `oe-smoke-issue-${teamId}`,
    commentId: `oe-smoke-comment-${teamId}`,
    nowMs: deps.now(),
  });
  deps.log(`signed POST /eve/v1/linear (agent-session created, team ${teamId})`);
  const signed = await deps.fetchImpl(`${base}/eve/v1/linear`, {
    method: "POST",
    headers: { "content-type": "application/json", "linear-signature": signLinearBody(deps.webhookSecret, body) },
    body,
  });
  let positiveOk = gate(
    "a signed Linear agent-session delivery is accepted (200)",
    signed.status === 200,
    `POST /eve/v1/linear -> ${signed.status}`,
  );

  if (positiveOk) {
    const deadline = deps.now() + firedTimeoutMs;
    let found: AuditWireEntry | undefined;
    for (;;) {
      found = (await readLinearAudit(deps, sinceIso)).find((r) => r.surface === surfaceKey);
      if (found || deps.now() >= deadline) break;
      await deps.sleep(pollIntervalMs);
    }
    positiveOk = gate(
      "the deployment audits OUR delivery (linear.external_policy_suppressed carries our scratch surface)",
      found !== undefined,
      found ? `${found.action} row at ${found.ts}, verdict ${String(found.detail?.verdict)}` : `no linear.external_policy_suppressed row carrying surface ${surfaceKey} within ${firedTimeoutMs}ms`,
    );
    if (positiveOk && found) {
      positiveOk = gate(
        "that suppression is the ROOM grain (verdict silent-room) — the scratch domain's declared policy",
        found.detail?.verdict === "silent-room",
        `verdict is ${String(found.detail?.verdict)}`,
      );
    }
  }

  const unsignedTeamId = `${linearSmokeTeamId(deps.now())}-u`;
  const unsignedSurfaceKey = linearSmokeSurfaceKey(unsignedTeamId);
  const unsignedSince = new Date(deps.now() - 30_000).toISOString();
  const unsignedBody = linearSmokeAgentSessionBody({
    sessionId: `oe-smoke-session-${unsignedTeamId}`,
    teamId: unsignedTeamId,
    issueId: `oe-smoke-issue-${unsignedTeamId}`,
    commentId: `oe-smoke-comment-${unsignedTeamId}`,
    nowMs: deps.now(),
  });
  deps.log(`unsigned POST /eve/v1/linear (agent-session created, team ${unsignedTeamId})`);
  const unsigned = await deps.fetchImpl(`${base}/eve/v1/linear`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: unsignedBody,
  });
  const refused = gate("an unsigned Linear agent-session delivery is refused (401)", unsigned.status === 401, `POST /eve/v1/linear (no signature) -> ${unsigned.status}`);

  await deps.sleep(unsignedGraceMs);
  const strayRows = (await readLinearAudit(deps, unsignedSince)).filter((r) => r.surface === unsignedSurfaceKey);
  const noTrace = gate(
    "the refused delivery leaves NO audit trace",
    strayRows.length === 0,
    strayRows.length === 0 ? `no linear.external_policy_suppressed row carries surface ${unsignedSurfaceKey}` : `${strayRows.length} row(s) carry the REFUSED surface`,
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

export interface SkippedRung {
  readonly rung: string;
  readonly label: string;
  readonly reason: string;
  readonly launchSurface: boolean;
}

export const GITHUB_INSTALLATION_SKIP: SkippedRung = {
  rung: "github",
  label: "the github installation rung (signed delivery at /eve/v1/github)",
  reason: "no E2E_GITHUB_WEBHOOK_SECRET/GITHUB_WEBHOOK_SECRET configured for this runner",
  launchSurface: true,
};

export const LINEAR_EXTERNAL_POLICY_SKIP: SkippedRung = {
  rung: "linear",
  label: "the linear external-policy room-grain rung",
  reason: "no E2E_LINEAR_WEBHOOK_SECRET/LINEAR_WEBHOOK_SECRET configured for this runner",
  launchSurface: false,
};

export interface SmokeRunSummary {
  readonly gatesOk: boolean;
  readonly skipped: readonly SkippedRung[];
  readonly optedOut: readonly SkippedRung[];
  readonly unproven: readonly SkippedRung[];
  readonly exitCode: number;
}

export function parseSkipOptOut(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((r) => r.trim().toLowerCase())
      .filter((r) => r !== ""),
  );
}

export function resolveSkipOptOut(flagValue: string | undefined, envValue: string | undefined): ReadonlySet<string> {
  return parseSkipOptOut(flagValue ?? envValue);
}

export function summariseSmokeRun(gatesOk: boolean, skipped: readonly SkippedRung[], allowSkip: ReadonlySet<string>): SmokeRunSummary {
  const launch = skipped.filter((s) => s.launchSurface);
  const optedOut = launch.filter((s) => allowSkip.has(s.rung.toLowerCase()));
  const unproven = launch.filter((s) => !allowSkip.has(s.rung.toLowerCase()));
  return { gatesOk, skipped, optedOut, unproven, exitCode: gatesOk && unproven.length === 0 ? 0 : 1 };
}

export function renderSkipSummary(summary: SmokeRunSummary): readonly string[] {
  const lines = [`\n  ── what this run did not prove ──`];
  if (summary.skipped.length === 0) {
    lines.push("  0 rung(s) skipped — every rung in the ladder ran");
    return lines;
  }
  for (const s of summary.skipped) {
    const posture = !s.launchSurface
      ? "opt-in rung, not a launch surface — reported, not gated"
      : summary.optedOut.includes(s)
        ? `🔴 LAUNCH SURFACE — waived by an explicit opt-out naming "${s.rung}"`
        : `🔴 LAUNCH SURFACE — NOT waived, so this run is RED (pass --allow-skip ${s.rung} to waive it on purpose)`;
    lines.push(`  SKIPPED (${s.reason}): ${s.label} — ${posture}`);
  }
  lines.push(
    summary.unproven.length === 0
      ? `  ${summary.skipped.length} rung(s) skipped, ${summary.optedOut.length} launch-surface waiver(s) — no unwaived launch-surface security rung`
      : `✗ deploy:smoke: ${summary.unproven.length} LAUNCH-SURFACE security rung(s) skipped with no opt-out — this ship did not earn its green (OPE-2154)`,
  );
  return lines;
}
