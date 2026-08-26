import type { GrantJsonObject } from "../operational/credential-grant-rows.js";

export type GrantSchemaPin =
  | { readonly ok: true; readonly schema: GrantJsonObject }
  | { readonly ok: false; readonly unknownKeys: readonly string[] };

export function pinFrozenArgsIntoSchema(vendorSchema: GrantJsonObject, frozenArgs: GrantJsonObject): GrantSchemaPin {
  const frozenKeys = Object.keys(frozenArgs);
  if (frozenKeys.length === 0) return { ok: true, schema: { ...vendorSchema } };
  const properties = plainObject(vendorSchema["properties"]) ?? {};
  const unknownKeys = frozenKeys.filter((key) => !Object.hasOwn(properties, key)).sort();
  if (unknownKeys.length > 0) return { ok: false, unknownKeys };
  const pinned: Record<string, unknown> = { ...properties };
  for (const key of frozenKeys) {
    const declared = plainObject(properties[key]) ?? {};
    const { enum: _enum, default: _default, ...kept } = declared;
    pinned[key] = { ...kept, const: frozenArgs[key] };
  }
  return { ok: true, schema: { ...vendorSchema, properties: pinned, required: withRequired(vendorSchema["required"], frozenKeys) } };
}

function withRequired(declared: unknown, frozenKeys: readonly string[]): readonly string[] {
  const existing = Array.isArray(declared) ? declared.filter((v): v is string => typeof v === "string") : [];
  return [...existing, ...frozenKeys.filter((key) => !existing.includes(key))];
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
