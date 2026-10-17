import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import type { MemoryWriteRoad } from "../memory/write-road.js";
import type { SessionMode } from "../access/resolver.js";

export interface PersonOptOutState {
  readonly optedOut: boolean;
  readonly readable: boolean;
  readonly since?: string;
}

export async function readPersonOptOut(org: string, principalKey: string): Promise<PersonOptOutState> {
  try {
    const row = await getOperationalStore().getPersonOptOut(org, principalKey);
    return row?.optedOutAt === undefined ? { optedOut: false, readable: true } : { optedOut: true, readable: true, since: row.optedOutAt };
  } catch (err) {
    console.warn(`[open-everywhere:person-opt-out] getPersonOptOut failed (${principalKey}): ${String(err)} — treating as opted out`);
    return { optedOut: true, readable: false };
  }
}

export type PersonOptOutVia = "command" | "app-home";

export interface PersonOptOutWhere {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly surfaceMode?: SessionMode;
  readonly principalKey: string;
}

export async function setPersonOptOut(where: PersonOptOutWhere, via: PersonOptOutVia, at = new Date().toISOString()): Promise<"set" | "already"> {
  const changed = await getOperationalStore().setPersonOptOut(where.org, where.principalKey, at);
  if (!changed) return "already";
  await appendAudit({
    org: where.org,
    platform: where.platform,
    workspace: where.workspace,
    surface: where.surface,
    ...(where.surfaceMode === undefined ? {} : { surfaceMode: where.surfaceMode }),
    principalId: where.principalKey,
    action: "person.opt_out.set",
    detail: { via },
  }).catch(() => undefined);
  return "set";
}

export async function clearPersonOptOut(where: PersonOptOutWhere, via: PersonOptOutVia): Promise<"cleared" | "not-set"> {
  const changed = await getOperationalStore().clearPersonOptOut(where.org, where.principalKey);
  if (!changed) return "not-set";
  await appendAudit({
    org: where.org,
    platform: where.platform,
    workspace: where.workspace,
    surface: where.surface,
    ...(where.surfaceMode === undefined ? {} : { surfaceMode: where.surfaceMode }),
    principalId: where.principalKey,
    action: "person.opt_out.cleared",
    detail: { via },
  }).catch(() => undefined);
  return "cleared";
}

export type PersonOptOutRefusedAct = "memory-write" | "message-shortcut";

export async function auditPersonOptOutRefusal(
  where: PersonOptOutWhere,
  act: PersonOptOutRefusedAct,
  detail: Readonly<Record<string, string | number | boolean>> = {},
): Promise<void> {
  await appendAudit({
    org: where.org,
    platform: where.platform,
    workspace: where.workspace,
    surface: where.surface,
    ...(where.surfaceMode === undefined ? {} : { surfaceMode: where.surfaceMode }),
    principalId: where.principalKey,
    action: "person.opt_out.refused",
    detail: { ...detail, act },
  }).catch(() => undefined);
}

export const OPT_OUT_MEMORY_ROADS: Readonly<Record<MemoryWriteRoad, "refuse" | "allow">> = {
  "session-persist": "refuse",
  "pinned-instructions": "refuse",
  "dream-learn": "refuse",
  "dream-tidy": "refuse",
  "status-board": "allow",
  "onboarding-marker": "allow",
  "self-edit": "allow",
  purge: "allow",
  "control-edit": "allow",
};

export const PERSON_OPT_OUT_UNREADABLE_NOTICE = "I could not check a setting just now, so I left that message alone. Try again in a moment.";

export const PERSON_OPT_OUT_SHORTCUT_NOTICE =
  "The author of that message asked me not to act on their content, so I left it alone. You can still ask me about the topic in your own words.";
