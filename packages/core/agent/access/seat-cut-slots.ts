export const SEAT_CUT_SPECIFIER = "@open-everywhere/core/agent/access/seat-cut.js";

export const SEAT_CUT_STATIC_SLOTS: Readonly<Record<string, string>> = {
  ask_question:
    "the module exports eve's built-in ask_question workflow tool, and eve throws when a defineDynamic() returns a built-in workflow tool, so this slot stays static and no seat cut reaches it",
};

export function seatCutApplies(slug: string): boolean {
  return !Object.prototype.hasOwnProperty.call(SEAT_CUT_STATIC_SLOTS, slug);
}
