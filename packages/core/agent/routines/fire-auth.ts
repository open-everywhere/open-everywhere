import { rootDmGrainAttrs } from "../channels/unified-window.js";
import { jobFireAttrs } from "../access/job-posture.js";
import type { SessionMode } from "../access/resolver.js";
import { FIRE_PRINCIPAL_ATTR, FIRE_PRINCIPAL_TRUST_ATTR, FIRE_UNATTENDED_ATTR } from "../identity/binding.js";
import { isJobRoutine, isSilentRoutine, routinePermissionKey, ROUTINE_MARKER, type Routine } from "./routine.js";

export function routineFireAttributes(
  r: Routine,
  destAttributes: Readonly<Record<string, string>>,
  mode: SessionMode,
  internal: boolean,
  creatorInternal?: boolean,
  fireId?: string,
): Record<string, string> {
  return {
    ...destAttributes,
    ...(internal ? { is_ext_shared: "false", trust_checked: "true" } : {}),
    [FIRE_UNATTENDED_ATTR]: "true",
    ...(r.createdBy ? { [FIRE_PRINCIPAL_ATTR]: r.createdBy } : {}),
    ...(creatorInternal === true ? { [FIRE_PRINCIPAL_TRUST_ATTR]: "internal" } : {}),
    ...rootDmGrainAttrs(
      mode === "dm" || mode === "mpim",
    ),
    ...jobFireAttrs(isJobRoutine(r), r.jobTainted === true),
    [ROUTINE_MARKER.id]: r.id,
    [ROUTINE_MARKER.surface]: r.surfaceKey,
    [ROUTINE_MARKER.org]: r.org,
    [ROUTINE_MARKER.permissionKey]: routinePermissionKey(r),
    ...(isSilentRoutine(r) ? { [ROUTINE_MARKER.silent]: "true" } : {}),
    ...(r.manualRunAt !== undefined ? { [ROUTINE_MARKER.manual]: "true" } : {}),
    ...(fireId !== undefined && fireId.length > 0 ? { [ROUTINE_MARKER.fire]: fireId } : {}),
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
    [FIRE_UNATTENDED_ATTR]: "true",
    ...rootDmGrainAttrs(isDm),
    [WEBHOOK_MARKER_ATTR]: hookId,
  };
}
