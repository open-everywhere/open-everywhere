import type { BindableContext } from "../identity/binding.js";
import { bindFrom } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { resolvePartition } from "../memory/partition.js";
import { appendAudit } from "./audit.js";

const MAX_AUDIT_ERROR_CHARS = 300;

const SECRET_SHAPES: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
];

function builtInAuditScrub(text: string): string {
  let scrubbed = text;
  for (const shape of SECRET_SHAPES) scrubbed = scrubbed.replace(shape, "[redacted]");
  return scrubbed;
}

function registeredAuditScrubArm(): ((text: string) => string) | undefined {
  try {
    return getConfig().auditScrub;
  } catch {
    return undefined;
  }
}

function scrubForAudit(raw: string): string {
  const builtIn = builtInAuditScrub(raw);
  const arm = registeredAuditScrubArm();
  if (!arm) return builtIn;
  try {
    return builtInAuditScrub(arm(builtIn));
  } catch (err) {
    console.warn(`[open-everywhere:audit] auditScrub arm threw; kept the built-in scrub: ${String(err)}`);
    return builtIn;
  }
}

export function auditErrorDetail(err: unknown): { readonly error: string } {
  const raw = err instanceof Error ? err.message : String(err);
  let text = scrubForAudit(raw);
  text = text.replace(/\s+/g, " ").trim();
  return { error: text.length <= MAX_AUDIT_ERROR_CHARS ? text : `${text.slice(0, MAX_AUDIT_ERROR_CHARS)}…` };
}

export async function auditToolAction(
  ctx: BindableContext,
  action: string,
  detail?: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    const p = resolvePartition(ctx);
    await appendAudit({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      principalId: bindFrom(ctx).principalId,
      action,
      detail,
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] dropped a "${action}" tool-action entry: ${String(err)}`);
  }
}
