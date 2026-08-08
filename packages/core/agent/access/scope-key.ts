import { principalKey } from "../identity/principal-key.js";

export type ScopeKeyShape =
  | { readonly kind: "domain"; readonly name: string }
  | { readonly kind: "tenant"; readonly platform: string; readonly workspace: string }
  | { readonly kind: "surface"; readonly platform: string; readonly workspace: string; readonly surface: string }
  | { readonly kind: "principal"; readonly platform: string; readonly id: string }
  | { readonly kind: "malformed"; readonly raw: string; readonly parts: readonly string[] };

export const USER_SCOPE_PREFIX = "user:";

export function userScopeKey(platform: string, id: string): string {
  return `${USER_SCOPE_PREFIX}${principalKey(platform, id)}`;
}

export function parseScopeKey(scopeKey: string): ScopeKeyShape {
  if (scopeKey.startsWith(USER_SCOPE_PREFIX)) {
    const rest = scopeKey.slice(USER_SCOPE_PREFIX.length);
    const parts = rest.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) return { kind: "principal", platform: parts[0], id: parts[1] };
    return { kind: "malformed", raw: scopeKey, parts };
  }
  const parts = scopeKey.split("/");
  if (parts.length === 1) return { kind: "domain", name: parts[0] };
  if (parts.some((p) => p.length === 0)) return { kind: "malformed", raw: scopeKey, parts };
  if (parts.length === 2) return { kind: "tenant", platform: parts[0], workspace: parts[1] };
  if (parts.length === 3) return { kind: "surface", platform: parts[0], workspace: parts[1], surface: parts[2] };
  return { kind: "malformed", raw: scopeKey, parts };
}

export function platformOfScopeKey(scopeKey: string | undefined | null): string | undefined {
  if (!scopeKey) return undefined;
  const parsed = parseScopeKey(scopeKey);
  return parsed.kind === "tenant" || parsed.kind === "surface" || parsed.kind === "principal" ? parsed.platform : undefined;
}
