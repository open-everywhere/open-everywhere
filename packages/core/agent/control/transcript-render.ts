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
      case "message.received":
        lines.push(`${ts} [woken with] ${clip(str(d.message), TRANSCRIPT_FIELD_CAPS.wake)}`);
        break;
      case "reasoning.completed": {
        const text = clip(str(d.reasoning), TRANSCRIPT_FIELD_CAPS.reasoning);
        if (text.length > 0) lines.push(`${ts} [thought] ${text}`);
        break;
      }
      case "message.completed": {
        const text = clip(str(d.message), TRANSCRIPT_FIELD_CAPS.assistant);
        if (text.length > 0) lines.push(`${ts} [said] ${text}`);
        break;
      }
      case "actions.requested": {
        for (const a of Array.isArray(d.actions) ? d.actions : []) {
          const action = asRecord(a);
          const name = str(action.toolName) || "?";
          const callId = str(action.callId);
          if (callId.length > 0) toolNameByCallId.set(callId, name);
          lines.push(`${ts} [called] ${name}(${clip(str(action.input), TRANSCRIPT_FIELD_CAPS.toolInput)})`);
        }
        break;
      }
      case "action.result": {
        const result = asRecord(d.result);
        const callId = str(result.callId);
        const name = toolNameByCallId.get(callId) ?? (callId.length > 0 ? `callId ${callId}` : "?");
        const status = str(d.status) || "completed";
        lines.push(`${ts} [${name} returned:${status}] ${clip(str(result.output), TRANSCRIPT_FIELD_CAPS.toolResult)}`);
        break;
      }
      case "session.failed":
        lines.push(`${ts} [run FAILED] ${clip(str(d.error ?? d.reason), TRANSCRIPT_FIELD_CAPS.assistant)}`);
        break;
      case "session.completed":
        lines.push(`${ts} [run ended]`);
        break;
      case "reasoning.appended":
      case "message.appended":
      case "step.started":
      case "step.completed":
      case "session.waiting":
      case "session.started":
      case "turn.started":
      case "turn.completed":
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
