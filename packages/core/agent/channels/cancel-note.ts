import { defineState } from "eve/context";

export interface PendingCancelNote {
  readonly turnId: string;
  readonly steps: number;
  readonly ran: readonly string[];
  readonly by?: string;
}

const MAX_NAMED_ACTIONS = 6;

const slot = defineState<PendingCancelNote | null>("open-everywhere.cancel-note.pending", () => null);

export function setPendingCancelNote(note: PendingCancelNote): void {
  try {
    slot.update(() => note);
  } catch {
  }
}

export function attachCancelNoteRequester(turnId: string, by: string): void {
  try {
    slot.update((prev) => (prev && prev.turnId === turnId ? { ...prev, by } : prev));
  } catch {
  }
}

export function readPendingCancelNote(): PendingCancelNote | null {
  try {
    return slot.get();
  } catch {
    return null;
  }
}

export function clearPendingCancelNoteAfter(endedTurnId: string): void {
  try {
    slot.update((prev) => (prev && prev.turnId !== endedTurnId ? null : prev));
  } catch {
  }
}

export function formatCancelNoteReminder(note: PendingCancelNote | null): string | null {
  if (!note) return null;
  const where = note.steps === 1 ? "one step in" : `${note.steps} steps in`;
  const who = note.by ? `by \`${note.by}\`` : "by a person";
  const head =
    `<system-reminder>\nYour PREVIOUS turn in this session was CANCELLED ${who} — you were stopped ` +
    `${where}, you did not finish, and your final message (if you had started one) was never recorded.`;
  const tail =
    `\nDo not silently start again from the beginning. Take the actions below as ALREADY DONE, and if ` +
    `you are unsure whether the interrupted work should continue, ask before you redo it.\n</system-reminder>`;
  if (note.ran.length === 0) {
    return `${head}\nNo tool had finished running, so nothing was left half-done.${tail}`;
  }
  const named = note.ran.slice(-MAX_NAMED_ACTIONS);
  const more = note.ran.length - named.length;
  const list = named.map((n) => `\`${n}\``).join(", ");
  const earlier = more > 0 ? ` (and ${more} earlier)` : "";
  return (
    `${head}\n` +
    `These tools DID run and their effects are REAL, but the cancel rolled them out of your history, ` +
    `so you cannot see them above: ${list}${earlier}.` +
    tail
  );
}

export function renderPendingCancelNote(): string | null {
  return formatCancelNoteReminder(readPendingCancelNote());
}
