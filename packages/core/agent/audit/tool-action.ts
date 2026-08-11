import type { BindableContext } from "../identity/binding.js";
import { bindFrom } from "../identity/binding.js";
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

export function auditErrorDetail(err: unknown): { readonly error: string } {
  const raw = err instanceof Error ? err.message : String(err);
  let text = raw;
  for (const shape of SECRET_SHAPES) text = text.replace(shape, "[redacted]");
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
