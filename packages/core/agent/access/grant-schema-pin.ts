import { reduceInputSchema } from "../connections/connector-catalog-text.js";
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

export type GrantOfferSchema =
  | {
      readonly ok: true;
      /** The schema the borrowed tool offers the model: the snapshot reduced to its shape, with each frozen argument pinned. */
      readonly schema: GrantJsonObject;
      /** True when the reduction dropped vendor text, so the description carries the snapshot inside the fence. */
      readonly dropped: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The input schema a credential-grant borrowed tool offers the model (`tools/grant_tools.ts`).
 *
 * The snapshot is the vendor's own MCP input schema, read at approval and pinned there
 * (`pinFrozenArgsIntoSchema`). The vendor wrote its property descriptions, enums, defaults and
 * patterns, so they can carry an injected instruction. The borrowed tool is in the model's tool
 * list, so the model reads its whole schema. An `eve__tool` call with an invalid input also gets the
 * schema back as a signature. So the snapshot goes through the connector catalog's reduction
 * (`connections/connector-catalog-text.ts#reduceInputSchema`) in its `shownWhole` mode, because eve
 * hands the provider the whole JSON schema: its shape stays, every free-text keyword goes, a
 * `$defs` key must be a short token, the root id goes, and the result is never stricter than eve's
 * own check of the snapshot. The residue is the catalog's: property names, `$defs` keys, local
 * `$ref` pointers and bounded short-token literals reach the model bare.
 *
 * The frozen arguments are not vendor text: the requester proposed them and the owner approved
 * them on the grant card. The reduction does not judge them: each
 * frozen property loses its pin before the reduction, and the pin goes back on the reduced
 * property after it. So every frozen argument stays a required `const` of the frozen value, also
 * where eve cannot check the snapshot and the reduced schema keeps the names alone. The schema pin
 * is guidance and an early refusal only. The borrow's call fence (`access/mcp-call-fence.ts`)
 * still compares each frozen argument on the wire.
 */
export function grantOfferSchema(snapshot: GrantJsonObject, frozenArgs: GrantJsonObject): GrantOfferSchema {
  // eve strips an own `__proto__` key from a call's input before it checks it, so a pinned,
  // required `__proto__` refuses every call. A tool that can never succeed is left out instead.
  if (Object.hasOwn(frozenArgs, "__proto__")) return { ok: false, reason: "the grant freezes an argument named __proto__, which eve strips from every call" };
  const reduced = reduceInputSchema(withoutPins(snapshot, Object.keys(frozenArgs)), { shownWhole: true });
  if (!reduced.ok) return reduced;
  const pinned = pinFrozenArgsIntoSchema(reduced.inputSchema, frozenArgs);
  if (!pinned.ok) return { ok: false, reason: `the reduced schema declares no ${pinned.unknownKeys.join(", ")} property for a frozen argument` };
  return { ok: true, dropped: reduced.dropped, schema: pinned.schema };
}

function withoutPins(snapshot: GrantJsonObject, frozenKeys: readonly string[]): GrantJsonObject {
  const properties = plainObject(snapshot["properties"]);
  if (properties === undefined || frozenKeys.length === 0) return snapshot;
  const unpinned: Record<string, unknown> = { ...properties };
  for (const key of frozenKeys) {
    const declared = plainObject(properties[key]);
    if (declared === undefined) continue;
    const { const: _const, ...kept } = declared;
    unpinned[key] = kept;
  }
  return { ...snapshot, properties: unpinned };
}

function withRequired(declared: unknown, frozenKeys: readonly string[]): readonly string[] {
  const existing = Array.isArray(declared) ? declared.filter((v): v is string => typeof v === "string") : [];
  return [...existing, ...frozenKeys.filter((key) => !existing.includes(key))];
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
