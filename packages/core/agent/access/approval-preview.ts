import { TOOL_CONSEQUENCE, type ConsequenceTier } from "./consequence.js";
import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS, memoryRecallRouteFor, type MemoryRecallRoute } from "./window-gate-manifest.js";
import { allowedOnLeanSeat } from "./lean-seat.js";
import type { WindowGrain } from "../identity/binding.js";

export interface ApprovalPreview {
  readonly member: readonly string[];
  readonly admin: readonly string[];
  readonly elsewhere: readonly string[];
  readonly confirm: readonly string[];
  readonly route: MemoryRecallRoute;
}

function mountedOn(name: string, grain: WindowGrain, gated: Readonly<Record<string, readonly WindowGrain[]>>, ungated: ReadonlySet<string>): boolean {
  const grains = gated[name];
  return grains ? grains.includes(grain) : ungated.has(name);
}

export function approvalPreviewFor(
  grain: WindowGrain,
  registry: Readonly<Record<string, { readonly tier: ConsequenceTier; readonly via: { readonly kind: string } }>> = TOOL_CONSEQUENCE,
  gated: Readonly<Record<string, readonly WindowGrain[]>> = WINDOW_GATED_TOOLS,
  ungated: ReadonlySet<string> = WINDOW_UNGATED_TOOLS,
  route: MemoryRecallRoute = memoryRecallRouteFor(grain),
): ApprovalPreview {
  const member: string[] = [];
  const admin: string[] = [];
  const elsewhere: string[] = [];
  const confirm: string[] = [];
  const lean = (grain === "standing" || grain === "thread") && route === "agent";
  const holds = (name: string): boolean => mountedOn(name, grain, gated, ungated) && (!lean || allowedOnLeanSeat(name));
  for (const [name, entry] of Object.entries(registry)) {
    if (entry.via.kind === "eve-hitl") {
      if (holds(name)) confirm.push(name);
      continue;
    }
    if (entry.via.kind !== "action-kind") continue;
    if (!holds(name)) elsewhere.push(name);
    else if (entry.tier === "gate:admin") admin.push(name);
    else member.push(name);
  }
  return { member: member.sort(), admin: admin.sort(), elsewhere: elsewhere.sort(), confirm: confirm.sort(), route };
}

const code = (names: readonly string[]): string => names.map((n) => "`" + n + "`").join(", ");

function elsewhereClause(elsewhere: readonly string[], route: MemoryRecallRoute): string {
  if (elsewhere.length === 0) return "";
  const names = code(elsewhere);
  if (route === "agent") {
    return (
      `${names} are not on this seat. A worker you delegate to with \`${route}\` holds them, and they ` +
      `stop for the same card there — handing work off never moves an action past a gate, it only moves ` +
      `where the card is proposed from.`
    );
  }
  if (route === "none") {
    return `${names} are not on this seat, and it cannot delegate — so they are simply out of reach here. Say that plainly rather than promising the work.`;
  }
  return `${names} are not on this seat.`;
}

export function renderApprovalPreview(preview: ApprovalPreview): string {
  const { member, admin, elsewhere, confirm, route } = preview;
  if (member.length === 0 && admin.length === 0 && elsewhere.length === 0) return "";
  const lines: string[] = [
    "## What stops for a human",
    "",
    "These verbs do not just run. Each one freezes its arguments onto a card, posts it, and hands you",
    "back a pending — nothing has happened yet. The act itself waits on a human click, which may land",
    "long after this turn ends, so never report the work as done because the call returned:",
    "",
  ];
  if (member.length > 0) lines.push(`- **Anyone here can approve**: ${code(member)}.`);
  if (admin.length > 0) lines.push(`- **Only an admin can approve**: ${code(admin)}.`);
  const away = elsewhereClause(elsewhere, route);
  if (away.length > 0) lines.push("", away);
  lines.push(
    "",
    "So say it up front. If what you are about to do needs a click — or several — name them in your",
    "reply while the person is still there, and ask for the clicks together rather than surfacing the",
    "third one an hour after the first.",
    "",
    ...(confirm.length > 0
      ? [`Separately, ${code(confirm)} may ask YOU to confirm before it goes out. That is a check with the person already here, not an approval — nobody else is waiting on it.`, ""]
      : []),
    "Be careful which way you state it: \"this will need approving\" is safe, \"this won't\" is not. Some",
    "of these only raise a card in certain cases — it can turn on what you are asking for, on whether",
    "this turn read untrusted content, or on a standing permission a human already granted — so promise",
    "the gate, never its absence.",
  );
  return lines.join("\n");
}

export function renderApprovalPreviewFor(grain: WindowGrain, route?: MemoryRecallRoute): string {
  try {
    return renderApprovalPreview(approvalPreviewFor(grain, undefined, undefined, undefined, route));
  } catch {
    return "";
  }
}
