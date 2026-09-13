import type { WakeMessageSender, WakeTrust } from "./wake-envelope.js";
import type { ContextLine } from "./context-render.js";

export interface SeatAdmissionCandidate {
  readonly sender: WakeMessageSender;
  readonly trust: WakeTrust;
  readonly type: "channel" | "thread";
  readonly authorId?: string;
}

export type SeatAdmissionFn = (candidate: SeatAdmissionCandidate) => boolean;

export const DEFAULT_ADMISSION = "wide";

export const SEAT_ADMISSION_FUNCTIONS: ReadonlyMap<string, SeatAdmissionFn> = new Map<string, SeatAdmissionFn>([
  ["wide", (c) => c.sender !== "bot"],
  ["wide-with-bots", (c) => c.sender !== "bot" || c.trust === "relay"],
  ["members-only", (c) => (c.sender !== "bot" && c.sender !== "human") || (c.sender === "human" && (c.trust === "principal" || c.trust === "peer"))],
]);

export function admissionFunctionNames(): readonly string[] {
  return [...SEAT_ADMISSION_FUNCTIONS.keys()];
}

export function isAdmissionFunctionName(name: unknown): name is string {
  return typeof name === "string" && SEAT_ADMISSION_FUNCTIONS.has(name);
}

export function admissionFunction(name: string | undefined): SeatAdmissionFn {
  return (name !== undefined ? SEAT_ADMISSION_FUNCTIONS.get(name) : undefined) ?? SEAT_ADMISSION_FUNCTIONS.get(DEFAULT_ADMISSION)!;
}

export function admitToSeat<T extends SeatAdmissionCandidate>(messages: readonly T[], admit: SeatAdmissionFn): T[] {
  return messages.filter((m) => admit(m));
}

function contextLineAdmission(line: ContextLine, type: "channel" | "thread"): SeatAdmissionCandidate {
  const sender: WakeMessageSender = line.senderType === "agent" ? "self" : line.senderType === "bot" ? "bot" : "human";
  const trust: WakeTrust = line.trust ?? (sender === "human" ? "unauth" : "relay");
  return { sender, trust, type, ...(line.senderId ? { authorId: line.senderId } : {}) };
}

export function admitContextLines(lines: readonly ContextLine[], admit: SeatAdmissionFn, type: "channel" | "thread"): ContextLine[] {
  return lines.filter((l) => admit(contextLineAdmission(l, type)));
}
