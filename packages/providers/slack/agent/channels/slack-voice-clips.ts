import { hearVoiceClips, isVoiceClip, voiceClipBody, type VoiceClipOutcome } from "@open-everywhere/core/agent/adapter-api.js";
import { bindableFor, type ParsedMessageEvent } from "./slack-events.js";
import { pullSlackAttachmentBytes } from "./slack-attachments.js";
import { slackTenantAdmission } from "./slack-tenant-fence.js";

const FALLBACK_MEDIA_TYPE = "audio/mp4";

export interface SlackVoiceClipDeps {
  readonly hear?: typeof hearVoiceClips;
  readonly pull?: typeof pullSlackAttachmentBytes;
}

export function hasSlackVoiceClip(ev: ParsedMessageEvent): boolean {
  return (ev.attachments ?? []).some(isVoiceClip);
}

export async function withSlackVoiceClips(ev: ParsedMessageEvent, deps: SlackVoiceClipDeps = {}): Promise<ParsedMessageEvent> {
  if (!hasSlackVoiceClip(ev)) return ev;
  if (ev.subtype === "message_changed") return ev;
  if (slackTenantAdmission(ev.teamId, ev.enterpriseId) === "unadmitted") return ev;
  const pull = deps.pull ?? pullSlackAttachmentBytes;
  let outcomes: VoiceClipOutcome[];
  try {
    const bindable = bindableFor(ev);
    outcomes = await (deps.hear ?? hearVoiceClips)({
      attachments: ev.attachments,
      bindable,
      load: async (clip, maxBytes) => {
        if (clip.url === undefined) throw new Error("the clip carries no download URL");
        const audio = await pull(bindable, { urlPrivate: clip.url, ...(clip.id ? { id: clip.id } : {}) }, maxBytes);
        return { audio, mediaType: clip.mimeType ?? FALLBACK_MEDIA_TYPE };
      },
    });
  } catch (err) {
    console.warn(`[open-everywhere:slack-voice-clips] ${ev.channelId}/${ev.ts}: voice clip step failed — the message goes on as typed: ${String(err)}`);
    return ev;
  }
  if (outcomes.length === 0) return ev;
  const { subtype, ...rest } = ev;
  return {
    ...rest,
    ...(subtype === undefined || subtype === "file_share" ? {} : { subtype }),
    text: voiceClipBody(ev.text, outcomes),
    authoredText: voiceClipBody(ev.authoredText, outcomes),
  };
}
