import type { BindableContext } from "../identity/binding.js";
import { auditSurfaceModeStamp, bindFrom } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { resolvePartition } from "../memory/partition.js";
import { appendAudit } from "./audit.js";
import type { AuditDetail, ScrubbedAuditText } from "./scrubbed-text.js";
import { SECRET_SHAPES } from "./secret-shapes.js";

const MAX_AUDIT_ERROR_CHARS = 300;

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

export function auditErrorDetail(err: unknown): { readonly error: ScrubbedAuditText } {
  return { error: scrubAuditText(err instanceof Error ? err.message : String(err)) };
}

export function scrubAuditText(raw: string): ScrubbedAuditText {
  const text = scrubForAudit(raw).replace(/\s+/g, " ").trim();
  return (text.length <= MAX_AUDIT_ERROR_CHARS ? text : `${text.slice(0, MAX_AUDIT_ERROR_CHARS)}…`) as ScrubbedAuditText;
}

const MAX_AUDIT_FRAMES = 8;

const MAX_AUDIT_FRAME_CHARS = 1200;

const MAX_FRAME_LINE_CHARS = 300;

const MAX_FRAME_NAME_WORDS = 4;

const MAX_FRAME_NAME_CHARS = 120;

const FRAME_NAME_WORD = /^[A-Za-z0-9_$.<>[\]#]+$/;

const CONTROL_CHARS = /[\p{Cc}\p{Cf}\u{2028}\u{2029}]/gu;

const FRAME_LOCATION = /\(?[^\s()]*[/\\.][^\s()]*:\d+:\d+\)?$/;

interface RenderedErrorLike {
  readonly stack?: unknown;
  readonly detail?: unknown;
}

function renderedErrorText(err: unknown): string {
  if (err instanceof Error) return typeof err.stack === "string" ? err.stack : "";
  if (typeof err === "string") return err;
  if (err === null || typeof err !== "object") return "";
  const like = err as RenderedErrorLike;
  if (typeof like.detail === "string") return like.detail;
  return typeof like.stack === "string" ? like.stack : "";
}

function frameOf(line: string): string | undefined {
  const text = line.replace(CONTROL_CHARS, " ").trim();
  if (!text.startsWith("at ") || text.length > MAX_FRAME_LINE_CHARS) return undefined;
  const location = FRAME_LOCATION.exec(text);
  if (location === null) return undefined;
  const name = text.slice(3, location.index).trim();
  if (name.length > MAX_FRAME_NAME_CHARS) return undefined;
  const words = name.length === 0 ? [] : name.split(/\s+/);
  if (words.length > MAX_FRAME_NAME_WORDS || !words.every((word) => FRAME_NAME_WORD.test(word))) return undefined;
  return text;
}

export function auditErrorFrames(err: unknown): string {
  const lines = renderedErrorText(err).split("\n");
  const frames: string[] = [];
  for (const line of lines) {
    if (frames.length >= MAX_AUDIT_FRAMES) break;
    const frame = frameOf(line);
    if (frame === undefined) continue;
    frames.push(scrubForAudit(frame));
  }
  const text = frames.join(" | ");
  return text.length <= MAX_AUDIT_FRAME_CHARS ? text : `${text.slice(0, MAX_AUDIT_FRAME_CHARS)}…`;
}

export async function auditToolAction(
  ctx: BindableContext,
  action: string,
  detail?: AuditDetail,
): Promise<void> {
  try {
    const p = resolvePartition(ctx);
    const binding = bindFrom(ctx);
    await appendAudit({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      ...auditSurfaceModeStamp(binding),
      principalId: binding.principalId,
      action,
      detail,
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] dropped a "${action}" tool-action entry: ${String(err)}`);
  }
}
