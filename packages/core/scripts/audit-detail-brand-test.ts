// proves: scrubAuditText, auditErrorDetail

import assert from "node:assert/strict";
import { auditErrorDetail, scrubAuditText } from "../agent/audit/tool-action.js";
import type { AuditInput } from "../agent/audit/audit.js";
import type { AuditDetail, ScrubbedAuditText } from "../agent/audit/scrubbed-text.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const where = { org: "o", platform: "slack", workspace: "T1", action: "test.row" } as const;
const err = new Error("upstream said: Bearer sk-live-abcdefghijklmnop");
const raw: string = err.message;
const helper = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const typeCases: AuditInput[] = [
  // @ts-expect-error a variable holding raw error text, under `error`
  { ...where, detail: { error: raw } },
  // @ts-expect-error a helper that renders error text, under `error`
  { ...where, detail: { error: helper(err) } },
  // @ts-expect-error a camel-case error key the type cannot name in advance
  { ...where, detail: { deliveryError: raw } },
  // @ts-expect-error an `error…` key
  { ...where, detail: { errorText: raw } },
  // @ts-expect-error the short `err` key
  { ...where, detail: { err: raw } },
  // @ts-expect-error a spread of an object built elsewhere
  { ...where, detail: { ...{ error: raw } } },
  // @ts-expect-error a template literal is still a plain string
  { ...where, detail: { error: `failed: ${raw}` } },
  { ...where, detail: { ...auditErrorDetail(err) } },
  { ...where, detail: { error: auditErrorDetail(err).error } },
  { ...where, detail: { deliveryError: scrubAuditText(raw), reason: "a product-written code" } },
  { ...where, detail: { error: null, errorCount: 3, timedOut: true } },
];

// @ts-expect-error a detail record typed as a plain record does not pass for a branded one
export const widened: AuditDetail = { error: raw } as Record<string, unknown>;

export function helperDetail(e: unknown): AuditDetail {
  // @ts-expect-error a helper that returns a detail must scrub its error field
  return { error: helper(e) };
}

const plainRecord: Record<string, unknown> = { error: raw };
export const pinnedGap: AuditInput = { ...where, detail: { ...plainRecord, id: 1 } };

{
  const scrubbed: ScrubbedAuditText = scrubAuditText(`opened it.\n  ${raw}`);
  ok(scrubbed.includes("[redacted]") && !scrubbed.includes("sk-live-abcdefghijklmnop"), `scrubAuditText strikes a credential shape (got ${scrubbed})`);
  ok(scrubbed === "opened it. upstream said: [redacted]", "scrubAuditText collapses whitespace and keeps the text around the token");
  ok(scrubAuditText("x".repeat(400)).length === 301, "scrubAuditText caps the text at 300 characters plus the ellipsis");
  ok(auditErrorDetail(err).error === scrubAuditText(err.message), "auditErrorDetail is scrubAuditText over the error's message");
  ok(auditErrorDetail("plain").error === "plain", "a non-Error value goes through the same road");
  ok(typeCases.length === 11, "every type case is present");
}

console.log(`audit-detail-brand-test: ${n} assertions passed`);
