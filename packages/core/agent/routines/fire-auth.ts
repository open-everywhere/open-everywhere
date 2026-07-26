import { rootDmGrainAttrs } from "../channels/unified-window.js";
import { jobFireAttrs } from "../access/job-posture.js";
import type { SessionMode } from "../access/resolver.js";
import { isJobRoutine, ROUTINE_MARKER, type Routine } from "./routine.js";

export function routineFireAttributes(
  r: Routine,
  destAttributes: Readonly<Record<string, string>>,
  mode: SessionMode,
  internal: boolean,
): Record<string, string> {
  return {
    ...destAttributes,
    ...(internal ? { is_ext_shared: "false", trust_checked: "true" } : {}),
    ...rootDmGrainAttrs(
      mode === "dm" || mode === "mpim" || destAttributes["chat_type"] === "group" || destAttributes["chat_type"] === "supergroup",
    ),
    ...jobFireAttrs(isJobRoutine(r), r.jobTainted === true),
    [ROUTINE_MARKER.id]: r.id,
    [ROUTINE_MARKER.surface]: r.surfaceKey,
    [ROUTINE_MARKER.org]: r.org,
  };
}

export const WEBHOOK_MARKER_ATTR = "open_everywhere_webhook_id";

export function webhookFireAttributes(
  hookId: string,
  teamId: string,
  channelId: string,
  isDm: boolean,
  internal: boolean,
): Record<string, string> {
  return {
    team_id: teamId,
    channel_id: channelId,
    channel_type: isDm ? "im" : "channel",
    ...(internal ? { is_ext_shared: "false", trust_checked: "true" } : {}),
    ...rootDmGrainAttrs(isDm),
    [WEBHOOK_MARKER_ATTR]: hookId,
  };
}
