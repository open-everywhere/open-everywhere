import type { Domain } from "../memory/domain.js";
import type { Binding } from "./bundle.js";
import { groupLinkSets, type Group } from "../identity/groups.js";
import { parseLinkSetRef } from "../identity/link-set-ref.js";

export function accessReferencedLinkSets(input: {
  readonly domains?: readonly Domain[];
  readonly bindings?: readonly Binding[];
  readonly groups?: readonly Group[];
}): Set<string> {
  const out = new Set<string>();
  for (const d of input.domains ?? []) {
    for (const entry of d.admins ?? []) {
      const id = parseLinkSetRef(entry);
      if (id !== undefined) out.add(id);
    }
  }
  for (const b of input.bindings ?? []) {
    if (b.scope.level === "principal" && b.scope.principal !== undefined) {
      const id = parseLinkSetRef(b.scope.principal);
      if (id !== undefined) out.add(id);
    }
  }
  for (const g of input.groups ?? []) {
    for (const id of groupLinkSets(g)) out.add(id);
  }
  return out;
}
