import { getOperationalStore } from "../operational/provider.js";
import type { PendingActionRow } from "../approvals/types.js";
import { ROUTINE_PERMISSION_KIND, type RoutinePermissionArgs } from "../approvals/routine-permission.js";
import {
  declarationForPermissionKind,
  describeDeclaredPermissionKind,
  isRoutinePermissionMemoKind,
  routinePermissionMemoParts,
} from "../approvals/session-grant.js";
import { routinePermissionKey, routineReportSurfaceKey, type Routine } from "./routine.js";
import { routinePermissionKeyParts } from "./permission-key.js";
import { placeWords } from "../channels/friendly-ids.js";

type ReviewedRoutine = Pick<Routine, "id" | "promptGeneration" | "surfaceKey" | "report">;

export type RoutinePermissionAskState =
  | "waiting"
  | "declined"
  | "superseded"
  | "lapsed"
  | "unreadable";

export interface RoutinePermissionAsk {
  readonly permission: string;
  readonly declaration: string | null;
  readonly state: RoutinePermissionAskState;
  readonly askedAt: string | null;
  readonly room: string | null;
  readonly nextStep: string;
}

export interface RoutinePermissionView {
  readonly permissions: string[];
  readonly asks: RoutinePermissionAsk[];
  readonly permissionsUnreadable: boolean;
}

export function emptyRoutinePermissionView(): RoutinePermissionView {
  return { permissions: [], asks: [], permissionsUnreadable: false };
}

export async function readRoutinePermissionViews(
  org: string,
  routines: readonly ReviewedRoutine[],
  nowIso: string,
): Promise<Map<string, RoutinePermissionView>> {
  const cards = await readRoutinePermissionCards(org);
  const out = new Map<string, RoutinePermissionView>();
  for (const routine of routines) out.set(routine.id, await readOneView(org, routine, nowIso, cards));
  return out;
}

async function readRoutinePermissionCards(org: string): Promise<readonly ParsedCard[] | undefined> {
  const rows = await getOperationalStore()
    .listPendingActions(org)
    .catch(() => undefined);
  if (rows === undefined) return undefined;
  const out: ParsedCard[] = [];
  for (const row of rows) {
    if (row.kind !== ROUTINE_PERMISSION_KIND) continue;
    const args = parseArgs(row.argsJson);
    if (args === undefined) continue;
    out.push({ row, args });
  }
  return out;
}

interface ParsedCard {
  readonly row: PendingActionRow;
  readonly args: Pick<RoutinePermissionArgs, "grantKey" | "grantKind" | "declaration" | "routineId">;
}

function parseArgs(argsJson: string): ParsedCard["args"] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const a = parsed as Partial<RoutinePermissionArgs>;
  if (typeof a.grantKey !== "string" || typeof a.grantKind !== "string") return undefined;
  if (typeof a.declaration !== "string" || typeof a.routineId !== "string") return undefined;
  return { grantKey: a.grantKey, grantKind: a.grantKind, declaration: a.declaration, routineId: a.routineId };
}

async function readOneView(
  org: string,
  routine: ReviewedRoutine,
  nowIso: string,
  cards: readonly ParsedCard[] | undefined,
): Promise<RoutinePermissionView> {
  const liveKey = routinePermissionKey(routine);
  const rows = await getOperationalStore()
    .listSessionApprovals(org, liveKey, nowIso)
    .catch(() => undefined);
  const permissionsUnreadable = rows === undefined;

  const permissions: string[] = [];
  const granted = new Set<string>();
  const asked = new Set<string>();
  const declined = new Set<string>();
  for (const row of rows ?? []) {
    if (!isRoutinePermissionMemoKind(row.kind)) {
      granted.add(row.kind);
      permissions.push(describeDeclaredPermissionKind(row.kind));
      continue;
    }
    const parts = routinePermissionMemoParts(row.kind);
    if (parts === undefined) continue;
    (parts.marker === "asked" ? asked : declined).add(parts.grantKind);
  }

  const live = new Map<string, ParsedCard>();
  const superseded = new Map<string, ParsedCard>();
  for (const card of cards ?? []) {
    const parts = routinePermissionKeyParts(card.args.grantKey);
    if (parts === undefined || parts.routineId !== routine.id) continue;
    const bucket = card.args.grantKey === liveKey ? live : superseded;
    if (!bucket.has(card.args.grantKind)) bucket.set(card.args.grantKind, card);
  }

  const asks: RoutinePermissionAsk[] = [];
  const seen = new Set<string>();
  const push = (grantKind: string, state: RoutinePermissionAskState, card: ParsedCard | undefined): void => {
    if (seen.has(grantKind)) return;
    seen.add(grantKind);
    asks.push({
      permission: describeDeclaredPermissionKind(grantKind),
      declaration: card?.args.declaration ?? declarationForPermissionKind(grantKind) ?? null,
      state,
      askedAt: card?.row.createdAt ?? null,
      room: card?.row.postedTo ?? null,
      nextStep: nextStepFor(state, placeWords({ key: card?.row.postedTo ?? routineReportSurfaceKey(routine) })),
    });
  };

  for (const grantKind of granted) seen.add(grantKind);
  for (const grantKind of declined) push(grantKind, "declined", undefined);
  for (const [grantKind, card] of live) push(grantKind, "waiting", card);
  for (const grantKind of asked) push(grantKind, cards === undefined ? "unreadable" : "lapsed", undefined);
  for (const [grantKind, card] of superseded) push(grantKind, "superseded", card);

  asks.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.askedAt ?? "").localeCompare(b.askedAt ?? ""));
  return { permissions, asks, permissionsUnreadable };
}

const STATE_ORDER: Record<RoutinePermissionAskState, number> = { waiting: 0, unreadable: 1, superseded: 2, lapsed: 3, declined: 4 };

function nextStepFor(state: RoutinePermissionAskState, room: string): string {
  switch (state) {
    case "waiting":
      return `Approve or decline the permission card waiting in ${room} — approving it arms every future run of this instruction.`;
    case "declined":
      return "Nothing is waiting: the routine stops asking until its instruction is edited. Editing it with `edit_routine` re-opens the question. To arm it outright, re-create the routine with the permission declared on its creation card: an edit cannot declare one.";
    case "superseded":
      return `The card in ${room} was posted under an earlier instruction, so answering it records nothing. The next run that needs the permission posts a fresh card.`;
    case "lapsed":
      return `No card is waiting and nothing was recorded. The next run that needs the permission posts a fresh card in ${room}. To arm it outright, re-create the routine with the permission declared on its creation card; an \`edit_routine\` cannot declare one, and it revokes the routine's standing permissions.`;
    case "unreadable":
      return `This routine asked for it, and the card store could not be read — so whether a card is still waiting in ${room} is unknown. Look there before deciding anything, and ask again once the store answers.`;
  }
}
