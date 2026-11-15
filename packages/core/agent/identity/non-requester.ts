export const OE_NON_REQUESTER_ATTR = "oe_non_requester";

export const NON_REQUESTER_KINDS = ["seat-wake", "task-brief", "work-result", "email-remainder", "redrive"] as const;
export type NonRequesterKind = (typeof NON_REQUESTER_KINDS)[number];

export function nonRequesterAttrs(kind: NonRequesterKind): Record<string, string> {
  return { [OE_NON_REQUESTER_ATTR]: kind };
}

export function nonRequesterAttrsIf(cond: boolean, kind: NonRequesterKind): Record<string, string> {
  return cond ? nonRequesterAttrs(kind) : {};
}

export function carriesNonRequesterStamp(attributes: Readonly<Record<string, unknown>> | undefined): boolean {
  const raw = attributes?.[OE_NON_REQUESTER_ATTR];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" && first.length > 0;
}
