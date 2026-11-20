export interface RenderableTranscriptEvent {
  readonly index: number;
  readonly at: string | null;
  readonly type: string;
  readonly data: unknown;
}

export const TRANSCRIPT_FIELD_CAPS = {
  wake: 2000,
  assistant: 2000,
  reasoning: 600,
  toolInput: 600,
  toolResult: 1500,
} as const;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+$/u, "");
  return t.length <= max ? t : `${t.slice(0, max)}… [+${t.length - max} chars truncated]`;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
}

function clock(at: string | null): string {
  const m = /T(\d{2}:\d{2}:\d{2})/u.exec(at ?? "");
  return m ? m[1] : "--:--:--";
}

function userPartsText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => {
      const part = asRecord(p);
      if (part.kind === "text") return str(part.text);
      return `[${str(part.kind) || "part"}${part.mediaType !== undefined ? ` ${str(part.mediaType)}` : ""}]`;
    })
    .filter((t) => t.length > 0)
    .join("\n");
}

/**
 * A value eve stored by reference (too large for a line, or withheld) renders as its preview with
 * a marker, never as an empty line.
 */
function valueText(inline: unknown, ref: unknown, fallback?: unknown): string {
  if (inline !== undefined && inline !== null) return str(inline);
  const r = asRecord(ref);
  if (Object.keys(r).length > 0) {
    if (r.withheld === true) return "[withheld]";
    const size = typeof r.size === "number" ? `, ${r.size} bytes` : "";
    const preview = typeof r.preview === "string" ? ` ${r.preview}` : "";
    return `[stored by reference${size}]${preview}`;
  }
  return str(fallback);
}

function errorText(d: Record<string, unknown>): string {
  const error = asRecord(d.error);
  return str(error.message ?? error.code ?? d.reason);
}

export interface TranscriptRenderMeta {
  readonly complete: boolean;
  readonly eventCount: number;
}

export function renderTranscript(events: readonly RenderableTranscriptEvent[], meta: TranscriptRenderMeta): string {
  const lines: string[] = [];
  const toolNameByCallId = new Map<string, string>();

  for (const ev of events) {
    const d = asRecord(ev.data);
    const ts = clock(ev.at);
    switch (ev.type) {
      case "delivery.consumed": {
        const text = userPartsText(d.parts);
        if (text.length > 0) lines.push(`${ts} [woken with] ${clip(text, TRANSCRIPT_FIELD_CAPS.wake)}`);
        break;
      }
      case "content.completed": {
        const kind = str(d.kind);
        if (kind === "reasoning") {
          const text = clip(valueText(d.value, d.valueRef, d.fallbackText), TRANSCRIPT_FIELD_CAPS.reasoning);
          if (text.length > 0) lines.push(`${ts} [thought] ${text}`);
        } else if (kind === "text") {
          const text = clip(valueText(d.value, d.valueRef, d.fallbackText), TRANSCRIPT_FIELD_CAPS.assistant);
          if (text.length > 0) lines.push(`${ts} [said] ${text}`);
        } else {
          const text = clip(valueText(d.value, d.valueRef, d.fallbackText ?? d.mediaType), TRANSCRIPT_FIELD_CAPS.assistant);
          lines.push(`${ts} [${kind || "content"}] ${text}`.trimEnd());
        }
        break;
      }
      case "call.requested": {
        const capability = asRecord(d.capability);
        const name = str(capability.name) || "?";
        const callId = str(d.callId);
        if (callId.length > 0) toolNameByCallId.set(callId, name);
        lines.push(`${ts} [called] ${name}(${clip(valueText(d.input, d.inputRef), TRANSCRIPT_FIELD_CAPS.toolInput)})`);
        break;
      }
      case "call.settled": {
        const callId = str(d.callId);
        const name = toolNameByCallId.get(callId) ?? (callId.length > 0 ? `callId ${callId}` : "?");
        const outcome = str(d.outcome) || "completed";
        const output = valueText(d.output, d.outputRef, asRecord(d.error).message ?? d.reason);
        lines.push(`${ts} [${name} returned:${outcome}] ${clip(output, TRANSCRIPT_FIELD_CAPS.toolResult)}`);
        break;
      }
      case "turn.settled": {
        const outcome = str(d.outcome);
        if (outcome === "failed") lines.push(`${ts} [turn FAILED] ${clip(errorText(d), TRANSCRIPT_FIELD_CAPS.assistant)}`);
        else if (outcome === "cancelled") lines.push(`${ts} [turn cancelled]`);
        break;
      }
      case "session.ended":
        if (str(d.outcome) === "failed") lines.push(`${ts} [run FAILED] ${clip(errorText(d), TRANSCRIPT_FIELD_CAPS.assistant)}`);
        else lines.push(`${ts} [run ended]`);
        break;
      case "model.settled": {
        const outcome = str(d.outcome);
        if (outcome !== "" && outcome !== "completed") lines.push(`${ts} [model call ${outcome}] ${clip(errorText(d), TRANSCRIPT_FIELD_CAPS.assistant)}`.trimEnd());
        break;
      }
      case "content.delta":
      case "call.input":
      case "call.progress":
      case "call.started":
      case "model.requested":
      case "model.started":
      case "usage.recorded":
      case "delivery.admitted":
      case "delivery.settled":
      case "session.started":
      case "turn.started":
        break;
      default:
        lines.push(`${ts} [${ev.type}]`);
    }
  }

  if (lines.length === 0) {
    lines.push(
      meta.eventCount === 0
        ? "(no recorded events — the run left no durable trace in the window read)"
        : `(${meta.eventCount} events recorded, none of them content — the run started but produced no message, tool call or result)`,
    );
  }
  if (!meta.complete) {
    lines.push("(transcript truncated — this is the start of the run, not all of it; the session was still open or the page bound was reached)");
  }
  return lines.join("\n");
}
